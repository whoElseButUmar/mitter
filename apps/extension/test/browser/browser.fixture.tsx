import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import {
  APP_VERSION,
  projectSchema,
  snapshotSchema,
  type Project,
} from '../../../../packages/protocol/src/index';
import { PreviewChunkSchema } from '../../../../packages/ui/src/preview';
import { Modal } from '../../src/components';
import { HostClient } from '../../src/client';
import { ProjectForm } from '../../src/forms/ProjectForm';
import { createFilePreview } from '../../src/ui/file-preview';
import { createTerminalAppearance } from '../../src/ui/terminal-appearance';
import { errorMessage } from '../../src/schemas/primitives';
import { TaskAttentionFixture, type TaskViewScenario } from './task-attention.fixture';
import { createDomReaderFixture } from './dom-reader.fixture';
import { createTaskStartFixture } from './task-start.fixture';
import { createAppFoundationFixture } from './app-foundation.fixture';
import { createSetupFixture } from './setup.fixture';
import { createProjectHomeFixture } from './project-home.fixture';
import { createProjectFormFixture } from './project-form.fixture';
import { createTaskRecoveryFixture } from './task-recovery.fixture';
import { createConfirmationFixture } from './confirmation.fixture';
import { createFeedbackFixture } from './feedback.fixture';

function deferred<Value>() {
  let callbacks: { resolve: (value: Value) => void; reject: (error: Error) => void } | undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    callbacks = { resolve, reject };
  });
  if (!callbacks) {
    throw new Error('Deferred callbacks are unavailable.');
  }
  return { promise, ...callbacks };
}

function fixtureElements() {
  const root = document.getElementById('fixture-root');
  const opener = document.getElementById('fixture-open-project');
  if (!(root instanceof HTMLElement) || !(opener instanceof HTMLButtonElement)) {
    throw new Error('The browser fixture requires its root and native opener button.');
  }
  return { root, opener };
}

const { root, opener } = fixtureElements();
const previewText = 'Browser-owned preview bytes.\n';
const chunk = PreviewChunkSchema.parse({
  path: 'fixture.txt',
  mime: 'text/plain',
  size: previewText.length,
  offset: 0,
  stamp: 'a'.repeat(64),
  data: btoa(previewText),
  eof: true,
});
type PendingSave = {
  fields: Pick<Project, 'name' | 'root'>;
  completion: ReturnType<typeof deferred<Project>>;
};
const saves = new Map<number, PendingSave>();
let disposeRoot: (() => void) | undefined;
let nextSave = 0;
let closes = 0;

let navigation = 'initial';
let preview: ReturnType<typeof createFilePreview> | undefined;
let assetRead: ReturnType<typeof deferred<typeof chunk>> | undefined;
let appearance: ReturnType<typeof createTerminalAppearance> | undefined;
const fontErrors: string[] = [];
const attentionActions: string[] = [];
let showTaskActivity: (() => void) | undefined;
const appFoundation = createAppFoundationFixture();
const confirmation = createConfirmationFixture();

function dispose() {
  const cleanup = disposeRoot;
  disposeRoot = undefined;
  cleanup?.();
}

function mount(component: () => JSX.Element) {
  dispose();
  opener.focus();
  disposeRoot = render(component, root);
}

function closeDialog() {
  closes++;
  dispose();
}

const taskRecovery = createTaskRecoveryFixture(mount, closeDialog);

function mountProject() {
  mount(() => (
    <ProjectForm
      close={closeDialog}
      pick={async () => ({ cancelled: false, root: '/controlled/project' })}
      save={(fields) => {
        const completion = deferred<Project>();
        saves.set(++nextSave, { fields, completion });
        return completion.promise;
      }}
      opened={(project) => {
        navigation = project.id;
      }}
    />
  ));
}

function mountAttention(reason: string, receiving = false, consoleOpen = true, workerError = '') {
  attentionActions.length = 0;
  mount(() => (
    <TaskAttentionFixture
      reason={reason}
      receiving={receiving}
      consoleOpen={consoleOpen}
      workerError={workerError}
      onAction={(name) => attentionActions.push(name)}
    />
  ));
}

function mountTaskState(scenario: TaskViewScenario) {
  attentionActions.length = 0;
  showTaskActivity = undefined;
  mount(() => (
    <TaskAttentionFixture
      reason=""
      receiving={false}
      consoleOpen={false}
      workerError=""
      scenario={scenario}
      onOutputReady={(showActivity) => {
        showTaskActivity = showActivity;
      }}
      onAction={(name) => attentionActions.push(name)}
    />
  ));
}

function mountReplacement() {
  navigation = 'replacement';
  mount(() => (
    <Modal title="Replacement dialog" close={closeDialog}>
      <label>
        Replacement draft
        <input id="fixture-replacement-draft" value="Newer draft" />
      </label>
    </Modal>
  ));
}

function finishSave(id: number, failure = '') {
  const save = saves.get(id);
  if (!save) {
    throw new Error('No pending project save with ID ' + id + '.');
  }
  saves.delete(id);
  if (failure) {
    save.completion.reject(new Error(failure));
  } else {
    save.completion.resolve(
      projectSchema.parse({
        id: 'fixture_project_' + id,
        ...save.fields,
        profiles: [],
        revision: 1,
      }),
    );
  }
}

function mountPreview(deferRead = false) {
  const completion = deferred<typeof chunk>();
  const previous = assetRead;
  assetRead = completion;
  mount(() => {
    const model = createFilePreview({
      workerId: 'fixture_worker',
      path: chunk.path,
      rpc: (method) => {
        if (method !== 'worker.asset') {
          return Promise.reject(new Error('Unexpected preview request: ' + method));
        }
        return completion.promise;
      },
    });
    preview = model;
    return <pre id="fixture-preview-source">{model.source()}</pre>;
  });
  previous?.reject(new Error('Preview replaced after disposal.'));
  if (!deferRead) {
    completion.resolve(chunk);
  }
}

function finishPreview() {
  const completion = assetRead;
  if (!completion) {
    throw new Error('No controlled preview read is available.');
  }
  assetRead = undefined;
  completion.resolve(chunk);
}

function mountFonts() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.storage?.local) {
    throw new Error('Font checks require an extension-origin fixture page and the built bundled font.');
  }

  mount(() => {
    const model = createTerminalAppearance(
      () => {},
      (error) => fontErrors.push(errorMessage(error)),
      () => {},
    );
    appearance = model;
    return <p id="fixture-font-ready">Font preferences ready: {String(model.ready())}</p>;
  });
}

function inspect() {
  const dialog = root.querySelector('dialog[open]');
  const heading = dialog?.querySelector('h2');
  const replacement = root.querySelector('#fixture-replacement-draft');
  let replacementDraft = '';
  if (replacement instanceof HTMLInputElement) {
    replacementDraft = replacement.value;
  }
  return {
    dialogs: document.querySelectorAll('dialog[open]').length,
    title: dialog?.querySelector('h2')?.textContent ?? '',
    sameTreeLabel: !!heading?.id && heading.id === dialog?.getAttribute('aria-labelledby'),
    activeId: document.activeElement?.id ?? '',
    replacementDraft,
    fields: [...root.querySelectorAll('form input')].map((input) => {
      if (!(input instanceof HTMLInputElement)) {
        throw new Error('Expected a native form input.');
      }
      return {
        value: input.value,
        userInvalid: input.matches(':user-invalid'),
        ariaInvalid: input.getAttribute('aria-invalid'),
        focused: document.activeElement === input,
      };
    }),
    alerts: [...root.querySelectorAll('[role="alert"]')].map((element) => ({
      text: element.textContent ?? '',
      visible: element.getClientRects().length > 0,
    })),
    busy: root.querySelector('form')?.getAttribute('aria-busy') === 'true',
    pendingSaves: [...saves].map(([id, save]) => ({ id, ...save.fields })),

    closes,

    navigation,
    preview: {
      bytes: preview?.asset()?.bytes.length ?? 0,
      url: preview?.url() ?? '',
      source: preview?.source() ?? '',

      error: preview?.error() ?? '',
      loading: preview?.loading() ?? false,
    },

    fontCount: [...document.fonts].length,
    fontReady: appearance?.ready() ?? false,
    savedFonts: appearance?.fonts().length ?? 0,
    systemFonts: appearance?.systemFonts().length ?? 0,
    fontErrors: [...fontErrors],
  };
}

async function checkNative(projectRoot: string) {
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(projectRoot)) {
    throw new Error('Pass the isolated test project’s absolute root to checkNative.');
  }
  const client = new HostClient(
    () => {},
    () => {},
  );
  try {
    client.connect();
    const initial = await client.request('state', {}, snapshotSchema);
    if (initial.projects.length !== 0 || initial.workers.length !== 0) {
      throw new Error('checkNative requires an isolated fresh host with no projects or workers.');
    }
    const version = initial.runtime.version;
    if (version !== APP_VERSION) {
      throw new Error('The isolated native host must match this extension’s release version.');
    }

    const projectName = 'Chrome release check';
    const added = await client.request(
      'project.add',
      { name: projectName, root: projectRoot },
      projectSchema,
    );
    if (added.root !== projectRoot || added.name !== projectName) {
      throw new Error(
        'The native project acknowledgement did not match the requested project. It was not retried.',
      );
    }
    const state = await client.request('state', {}, snapshotSchema);
    const registered = state.projects.find((project) => project.id === added.id);
    if (
      state.runtime.version !== version ||
      state.projects.length !== 1 ||
      state.workers.length !== 0 ||
      !registered ||
      registered.root !== projectRoot ||
      registered.name !== projectName
    ) {
      throw new Error(
        'The native state did not retain the exact added project. The mutation was not retried.',
      );
    }
    return {
      version,
      projectId: registered.id,
      root: registered.root,
      initialProjects: initial.projects.length,
      projects: state.projects.length,
      workers: state.workers.length,
    };
  } finally {
    client.close();
  }
}

function destroy() {
  taskRecovery.dispose();
  confirmation.dispose();
  appFoundation.dispose();
  dispose();
  opener.removeEventListener('click', mountProject);
  for (const id of saves.keys()) {
    finishSave(id, 'Fixture destroyed after disposal.');
  }
  assetRead?.reject(new Error('Fixture destroyed after disposal.'));
  assetRead = undefined;
  preview = undefined;
  appearance = undefined;
  attentionActions.length = 0;
  showTaskActivity = undefined;
}

opener.addEventListener('click', mountProject);
Object.assign(window, {
  mitterReleaseFixture: {
    appFoundation,
    domReader: createDomReaderFixture(),
    taskStart: createTaskStartFixture(mount, closeDialog),
    taskRecovery,
    setup: createSetupFixture(mount),
    projectHome: createProjectHomeFixture(mount),
    projectForm: createProjectFormFixture(mount, closeDialog),
    confirmation,
    feedback: createFeedbackFixture(mount),
    mountProject,
    mountReplacement,
    mountAttention,
    mountTaskState,
    showTaskActivity: () => {
      if (!showTaskActivity) {
        throw new Error('Mount a task state before opening its activity.');
      }
      showTaskActivity();
    },
    attentionActions: () => [...attentionActions],
    finishSave,
    mountPreview,
    finishPreview,
    mountFonts,
    dispose,
    inspect,
    checkNative,

    destroy,
  },
});
