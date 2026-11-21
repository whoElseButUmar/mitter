import { createSignal, onCleanup, type Accessor } from 'solid-js';
import {
  projectSchema,
  workerSchema,
  type Profile,
  type Project,
} from '../../../../packages/protocol/src/index';
import {
  projectContextSchema,
  projectCreateParamsSchema,
  type ProjectCreateParams,
} from '../../../../packages/protocol/src/rpc.js';
import { notificationPreferencesSchema, type NotificationPreferences } from '../schemas/messages';
import { validateViewParams } from '../schemas/view-rpc.js';
import type { RenameTarget } from './view-data';
import { folderPickSchema, type FolderPick } from './rpc-results';
import { callResult, type ViewRPC } from './rpc';
import { errorMessage } from '../schemas/primitives';

function createSubmissionLifetime(closeDialog: () => void) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  let alive = true;
  let generation = 0;

  const dispose = () => {
    alive = false;
    generation++;
    setBusy(false);
  };

  onCleanup(dispose);

  const close = () => {
    if (!alive) {
      return;
    }

    dispose();
    closeDialog();
  };

  const run = async <Result>(
    send: (isCurrent: () => boolean) => Promise<Result>,
    complete: (result: Result) => void,
    failed?: (error: unknown) => void,
  ): Promise<void> => {
    if (!alive || busy()) {
      return;
    }

    const operation = ++generation;
    const isCurrent = () => alive && operation === generation;
    setBusy(true);
    setError('');

    try {
      // Start work synchronously: permission acquisition must retain the submit gesture.
      const result = await send(isCurrent);

      if (isCurrent()) {
        complete(result);
      }
    } catch (error) {
      if (isCurrent()) {
        setError(errorMessage(error));
        failed?.(error);
      }
    } finally {
      if (isCurrent()) {
        setBusy(false);
      }
    }
  };

  return { busy, error, close, run };
}

function requireProject(projectId: string | undefined, projects: Project[]): string {
  if (!projectId || !projects.some((project) => project.id === projectId)) {
    throw new Error('This project is no longer available.');
  }

  return projectId;
}

type FormFeedback = {
  close: () => void;
  success: (message: string) => void;
};

export type ProjectDraftOptions = {
  close: () => void;
  pick: (purpose?: 'project' | 'parent') => Promise<FolderPick>;
  save: (project: Pick<Project, 'name' | 'root'>) => Promise<Project>;
  create?: (fields: ProjectCreateParams) => Promise<Project>;
  initialMode?: 'open' | 'create';
  opened: (project: Project) => void;
};

function folderDisplayName(root: string): string {
  let label = root.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || 'Project';
  label = label.slice(0, 60);
  if (/[\uD800-\uDBFF]$/.test(label)) {
    label = label.slice(0, -1);
  }
  return label;
}

export function createProjectDraft(options: ProjectDraftOptions) {
  const { busy, error, close, run } = createSubmissionLifetime(options.close);
  const [mode, writeMode] = createSignal<'open' | 'create'>(options.initialMode ?? 'open');
  const [operation, setOperation] = createSignal<'choose' | 'save'>('choose');
  const [fields, writeFields] = createSignal({
    open: { root: '', name: '', named: false },
    create: { root: '', name: '', named: false },
  });
  const [folderName, writeFolderName] = createSignal('');
  const root = () => fields()[mode()].root;
  const name = () => fields()[mode()].name;
  let rootRevision = 0;

  const setMode = (value: 'open' | 'create') => {
    if (!busy() && (value === 'open' || options.create)) {
      rootRevision++;
      writeMode(value);
    }
  };

  const setRoot = (value: string) => {
    rootRevision++;
    const currentMode = mode();
    writeFields((all) => {
      const current = all[currentMode];
      let nextName = current.name;
      if (currentMode === 'open' && !current.named) {
        nextName = folderDisplayName(value);
      }
      return { ...all, [currentMode]: { ...current, root: value, name: nextName } };
    });
  };
  const setName = (value: string) => {
    const currentMode = mode();
    writeFields((all) => ({ ...all, [currentMode]: { ...all[currentMode], name: value, named: true } }));
  };
  const setFolderName = (value: string) => {
    writeFolderName(value);
    writeFields((all) => {
      if (all.create.named) {
        return all;
      }
      return { ...all, create: { ...all.create, name: folderDisplayName(value) } };
    });
  };

  const choose = (): Promise<void> => {
    if (busy()) {
      return Promise.resolve();
    }
    setOperation('choose');
    const choosingRootRevision = rootRevision;
    let purpose: 'project' | 'parent' = 'project';
    if (mode() === 'create') {
      purpose = 'parent';
    }

    return run(
      async () => {
        try {
          return folderPickSchema.parse(await options.pick(purpose));
        } catch (event) {
          throw new Error(
            'The folder picker could not finish. Enter a folder path or choose again. ' + errorMessage(event),
            {
              cause: event,
            },
          );
        }
      },
      (result) => {
        if (result.cancelled || !result.root || choosingRootRevision !== rootRevision) {
          return;
        }
        setRoot(result.root);
      },
    );
  };

  const save = (): Promise<void> => {
    if (busy()) {
      return Promise.resolve();
    }
    setOperation('save');
    return run(
      async () => {
        const creating = mode() === 'create';
        const location = root();
        let displayName = name().trim();
        if (!location.trim()) {
          throw new Error('Choose a folder first, or enter its path in Advanced options.');
        }
        if (!displayName) {
          let source = location;
          if (creating) {
            source = folderName();
          }
          displayName = folderDisplayName(source);
        }
        let creation: ProjectCreateParams | undefined;
        if (creating) {
          const parsed = projectCreateParamsSchema.safeParse({
            parentRoot: location,
            folderName: folderName(),
            name: displayName,
          });
          if (!parsed.success) {
            throw new Error(parsed.error.issues[0]?.message || 'Check the new folder name and location.');
          }
          if (!options.create) {
            throw new Error(
              'Creating a project is unavailable in this view. Open an existing folder instead.',
            );
          }
          creation = parsed.data;
        }
        try {
          if (creation && options.create) {
            return projectSchema.parse(await options.create(creation));
          }
          return projectSchema.parse(await options.save({ name: displayName, root: location }));
        } catch (event) {
          let recovery = 'Check the project list before repeating the action. ';
          if (creating) {
            recovery =
              'The folder may already exist. Check the project list or use Open existing for that folder; no request was retried. ';
          }
          throw new Error(
            'Miter could not confirm that the project opened. ' + recovery + errorMessage(event),
            {
              cause: event,
            },
          );
        }
      },
      (added) => {
        close();
        options.opened(added);
      },
    );
  };

  return {
    busy,
    error,
    root,
    setRoot,
    name,
    setName,
    mode,
    setMode,
    folderName,
    setFolderName,
    choose,
    save,
    close,
    choosing: () => busy() && operation() === 'choose',
    saving: () => busy() && operation() === 'save',
  };
}

export type ContextDraftOptions = FormFeedback & {
  project: Accessor<Project | undefined>;
  projects: Accessor<Project[]>;
  rpc: ViewRPC;
  notice?: (message: string) => void;
};

export function createContextDraft(options: ContextDraftOptions) {
  const { busy, error, close, run } = createSubmissionLifetime(options.close);
  const project = options.project();
  const capturedProjectId = project?.id;
  const [mission, setMission] = createSignal(project?.mission || '');
  const [conventions, setConventions] = createSignal(project?.conventions || '');

  const save = (): Promise<void> =>
    run(
      async () => {
        const projectId = requireProject(capturedProjectId, options.projects());
        return callResult(options.rpc, projectContextSchema, 'project.context', {
          projectId,
          save: true,
          mission: mission(),
          conventions: conventions(),
        });
      },
      () => {
        close();
        options.success('Project context saved for all tasks.');
      },
      (error) => options.notice?.(errorMessage(error)),
    );

  return { mission, setMission, conventions, setConventions, busy, error, close, save };
}

export type ProfileDraftOptions = FormFeedback & {
  project: Project;
  projects: Accessor<Project[]>;
  save: (request: { projectId: Project['id']; profile: Profile }) => Promise<void>;
};

export function createProfileDraft(options: ProfileDraftOptions) {
  const { busy, error, close, run } = createSubmissionLifetime(options.close);
  const capturedProjectId = options.project.id;

  const save = (profile: () => Profile): Promise<void> =>
    run(
      async () => {
        const projectId = requireProject(capturedProjectId, options.projects());
        return options.save({ projectId, profile: profile() });
      },
      () => {
        close();
        options.success('Command profile saved.');
      },
    );

  return { busy, error, close, save };
}

export type NotificationsDraftOptions = FormFeedback & {
  preferences: NotificationPreferences;
  rpc: ViewRPC;
  notice?: (message: string) => void;
};

export function createNotificationsDraft(options: NotificationsDraftOptions) {
  const { busy, error, close, run } = createSubmissionLifetime(options.close);
  const [preferences, setPreferences] = createSignal(options.preferences);

  const save = (): Promise<void> =>
    run(
      async (isCurrent) => {
        const currentPreferences = preferences();
        validateViewParams('notifications.set', currentPreferences);

        if (
          currentPreferences.enabled &&
          !(await chrome.permissions.request({ permissions: ['notifications'] }))
        ) {
          throw new Error('Notification permission was not granted.');
        }

        if (isCurrent()) {
          await callResult(
            options.rpc,
            notificationPreferencesSchema,
            'notifications.set',
            currentPreferences,
          );
        }
      },
      () => {
        close();
        options.success('Notification settings saved.');
      },
      (error) => options.notice?.(errorMessage(error)),
    );

  return { preferences, setPreferences, busy, error, close, save };
}

export type RenameDraftOptions = FormFeedback & {
  target: RenameTarget & { name: string };
  rpc: ViewRPC;
};

export function createRenameDraft(options: RenameDraftOptions) {
  const { busy, error, close, run } = createSubmissionLifetime(options.close);
  const target = options.target;
  const [name, setName] = createSignal(target.name);

  const save = (): Promise<void> =>
    run(
      async () => {
        const trimmedName = name().trim();

        if (target.kind === 'project') {
          return callResult(options.rpc, projectSchema, 'project.rename', {
            projectId: target.id,
            name: trimmedName,
          });
        }

        return callResult(options.rpc, workerSchema, 'worker.rename', {
          workerId: target.id,
          name: trimmedName,
        });
      },
      () => {
        close();
        options.success('Name updated. Your folder, goal and progress are unchanged.');
      },
    );

  return { target, name, setName, busy, error, close, save };
}
