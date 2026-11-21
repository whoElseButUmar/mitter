import { batch, createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js';
import type { Activity, Project, Snapshot, Worker } from '../../../../packages/protocol/src/index';
import type { MenuItem } from '../../../../packages/ui/src/menu';
import { filePreviewURL, fileWindowOptions } from '../../../../packages/ui/src/file-target';
import { callResult, type ViewRPC } from './rpc';
import { fileListSchema, historyResultSchema } from './rpc-results';
import { changedFileSchema, type ChangedFile } from './view-data';
import { errorMessage } from '../schemas/primitives';

export type OutputView = 'result' | 'activity' | 'team';
export type FileListing = { workerId: string; files: string[] };

type TaskOutputDependencies = {
  snapshot: Accessor<Snapshot>;
  selected: Accessor<string>;
  worker: Accessor<Worker | undefined>;
  project: Accessor<Project | undefined>;
  connected: Accessor<boolean>;
  rpc: ViewRPC;
  notice: (message: string) => void;
  success: (message: string) => void;
  copy: (text: string) => Promise<void>;
  action: (method: string, params: Record<string, unknown>) => Promise<void>;
  modal: Accessor<string>;
  setModal: (modal: string) => void;
};

function mergeActivity(currentEvents: Activity[], incomingEvents: Activity[]): Activity[] {
  const eventsById = new Map<number, Activity>();

  for (const events of [currentEvents, incomingEvents]) {
    for (const event of events) {
      eventsById.set(event.id, event);
    }
  }

  return [...eventsById.values()];
}

export class TaskOutput {
  private readonly filesState = createSignal<ChangedFile[]>([]);
  private readonly fileState = createSignal('');
  private readonly previewRequestState = createSignal(0);
  private readonly viewState = createSignal<OutputView>('result');
  // Native <details> toggles before its toggle event syncs this signal. An
  // explicit file/history action must reassert open even in that interval.
  private readonly expandedState = createSignal(false, { equals: false });
  private readonly libraryState = createSignal<FileListing | undefined>();
  private readonly savedActivity = createSignal<Activity[]>([]);
  private readonly moreState = createSignal(false);
  private readonly busyState = createSignal(false);
  private readonly browsingState = createSignal(false);
  private readonly filesLoadingState = createSignal(false);
  private readonly filesErrorState = createSignal('');
  private readonly historyErrorState = createSignal('');

  readonly files = this.filesState[0];
  readonly file = this.fileState[0];
  readonly previewRequest = this.previewRequestState[0];
  readonly view = this.viewState[0];
  readonly expanded = this.expandedState[0];
  readonly setExpanded = this.expandedState[1];
  readonly setView = (view: OutputView): void => {
    this.viewState[1](view);
    this.setExpanded(true);
  };
  readonly fileLibrary = this.libraryState[0];
  readonly historyMore = this.moreState[0];
  readonly historyBusy = this.busyState[0];
  readonly browsing = this.browsingState[0];
  readonly filesLoading = this.filesLoadingState[0];
  readonly filesError = this.filesErrorState[0];
  readonly historyError = this.historyErrorState[0];
  readonly activity: Accessor<Activity[]>;

  private alive = true;
  private filesKey = '';
  private filesGeneration = 0;
  private browserGeneration = 0;
  private scopeGeneration = 0;
  private historyGeneration = 0;
  private historyTask = '';
  private historyBefore: number | null = null;

  constructor(private dependencies: TaskOutputDependencies) {
    const browseScope = createMemo(() => {
      const task = dependencies.worker();
      const project = dependencies.project();
      return JSON.stringify([
        dependencies.selected(),
        task?.id,
        task?.projectId,
        task?.runId,
        task?.control?.epoch ?? 0,
        task?.worktree?.root,
        project?.id,
        project?.root,
        dependencies.connected(),
      ]);
    });
    let previousBrowseScope = '';
    createEffect(() => {
      const scope = browseScope();
      dependencies.modal();
      this.browserGeneration++;
      this.browsingState[1](false);
      if (scope !== previousBrowseScope) {
        previousBrowseScope = scope;
        this.libraryState[1](undefined);
      }
    });

    let readActivity: Accessor<Activity[]> | undefined = createMemo(() => {
      const id = dependencies.selected();
      const events = mergeActivity(dependencies.snapshot().events, this.savedActivity[0]());

      const selectedEvents = events.filter((event) => event.workerId === id);

      return selectedEvents.sort((first, second) => second.id - first.id);
    });

    this.activity = () => {
      if (readActivity === undefined) {
        return [];
      }

      return readActivity();
    };

    createEffect(() => {
      const id = dependencies.selected();
      const connected = dependencies.connected();

      if (!id || !connected) {
        this.historyGeneration++;
        this.historyTask = '';
        this.busyState[1](false);
        this.historyErrorState[1]('');
        return;
      }

      if (this.view() === 'activity' && this.historyTask !== id) {
        void this.loadHistory(true);
      }
    });

    let previousFilesScope = '';
    createEffect(() => {
      const task = dependencies.worker();
      const connected = dependencies.connected();
      const scope = browseScope();

      if (scope !== previousFilesScope) {
        previousFilesScope = scope;
        this.scopeGeneration++;
        this.filesState[1]([]);
        this.fileState[1]('');
      }

      if (!task || !connected) {
        this.filesGeneration++;
        this.filesKey = '';
        this.filesState[1]([]);
        this.fileState[1]('');
        this.filesLoadingState[1](false);
        this.filesErrorState[1]('');
        return;
      }

      const key = JSON.stringify([
        task.id,
        task.runId,
        task.control?.epoch ?? 0,
        task.worktree?.root,
        task.state,
        dependencies.project()?.root,
        dependencies.project()?.revision ?? 0,
      ]);

      if (key !== this.filesKey) {
        this.filesKey = key;
        void this.refreshFiles(task.id);
      }
    });

    onCleanup(() => {
      this.alive = false;
      // Pending RPCs can retain this owner after Solid disposes its cached activity.
      readActivity = undefined;
      this.scopeGeneration++;
      this.filesGeneration++;
      this.browserGeneration++;
      this.historyGeneration++;

      batch(() => {
        this.filesState[1]([]);
        this.fileState[1]('');
        this.previewRequestState[1]((request) => request + 1);
        this.libraryState[1](undefined);
        this.savedActivity[1]([]);
        this.moreState[1](false);
        this.busyState[1](false);
        this.browsingState[1](false);
        this.filesLoadingState[1](false);
        this.filesErrorState[1]('');
        this.historyErrorState[1]('');
      });
    });
  }

  reset(): void {
    this.scopeGeneration++;
    this.filesGeneration++;
    this.browserGeneration++;
    this.historyGeneration++;
    this.filesKey = '';
    this.historyTask = '';
    this.historyBefore = null;

    batch(() => {
      this.filesState[1]([]);
      this.fileState[1]('');
      this.previewRequestState[1]((request) => request + 1);
      this.libraryState[1](undefined);

      if (this.dependencies.modal() === 'files') {
        this.dependencies.setModal('');
      }

      this.viewState[1]('result');
      this.setExpanded(false);
      this.savedActivity[1]([]);
      this.moreState[1](false);
      this.busyState[1](false);
      this.browsingState[1](false);
      this.filesLoadingState[1](false);
      this.filesErrorState[1]('');
      this.historyErrorState[1]('');
    });
  }

  preview = (path: string): void => {
    if (!this.alive) {
      return;
    }

    batch(() => {
      this.fileState[1](path);
      this.setView('result');
      this.previewRequestState[1]((request) => request + 1);
    });
  };

  loadHistory = async (reset = false): Promise<void> => {
    const id = this.dependencies.selected();

    if (!id || !this.alive || !this.dependencies.connected()) {
      return;
    }

    if (reset) {
      this.historyTask = id;
    }

    const generation = ++this.historyGeneration;
    this.busyState[1](true);
    this.historyErrorState[1]('');

    try {
      const params: Record<string, unknown> = { workerId: id };

      if (!reset && this.historyBefore) {
        params.before = this.historyBefore;
      }

      const result = await callResult(this.dependencies.rpc, historyResultSchema, 'worker.history', params);

      if (this.alive && generation === this.historyGeneration && id === this.dependencies.selected()) {
        this.savedActivity[1]((events) => {
          if (reset) {
            return mergeActivity([], result.events);
          }

          return mergeActivity(events, result.events);
        });
        this.moreState[1](result.hasMore);
        this.historyBefore = result.before;
      }
    } catch (error) {
      if (this.alive && generation === this.historyGeneration) {
        if (reset) {
          this.historyTask = '';
        }

        this.historyErrorState[1](errorMessage(error));
      }
    } finally {
      if (this.alive && generation === this.historyGeneration) {
        this.busyState[1](false);
      }
    }
  };

  retryHistory = async (): Promise<void> => {
    if (!this.historyBusy()) {
      await this.loadHistory(this.historyTask !== this.dependencies.selected());
    }
  };

  retryFiles = async (): Promise<void> => {
    const id = this.dependencies.selected();
    if (this.alive && id && this.dependencies.connected() && !this.filesLoading()) {
      await this.refreshFiles(id);
    }
  };

  private async refreshFiles(id: string): Promise<void> {
    const generation = ++this.filesGeneration;
    this.filesLoadingState[1](true);
    this.filesErrorState[1]('');

    try {
      const files = await callResult(this.dependencies.rpc, changedFileSchema.array(), 'worker.files', {
        workerId: id,
      });

      if (this.alive && generation === this.filesGeneration && id === this.dependencies.selected()) {
        this.filesState[1](files);
      }
    } catch (error) {
      if (this.alive && generation === this.filesGeneration) {
        this.filesKey = '';
        this.filesErrorState[1](errorMessage(error));
      }
    } finally {
      if (this.alive && generation === this.filesGeneration) {
        this.filesLoadingState[1](false);
      }
    }
  }

  browseFiles = async (): Promise<void> => {
    const id = this.dependencies.selected();
    const task = this.dependencies.worker();
    const project = this.dependencies.project();
    if (
      !this.alive ||
      !this.dependencies.connected() ||
      !id ||
      this.browsing() ||
      task?.id !== id ||
      !project ||
      task.projectId !== project.id
    ) {
      return;
    }

    const generation = ++this.browserGeneration;
    const isCurrent = () => this.alive && generation === this.browserGeneration;
    this.browsingState[1](true);

    try {
      const result = await callResult(this.dependencies.rpc, fileListSchema, 'worker.browse', {
        workerId: id,
      });

      if (isCurrent()) {
        this.libraryState[1]({ workerId: id, files: result.files });
        this.dependencies.setModal('files');
      }
    } catch (error) {
      if (isCurrent()) {
        this.dependencies.notice(errorMessage(error));
      }
    } finally {
      if (isCurrent()) {
        this.browsingState[1](false);
      }
    }
  };

  previewListedFile = (listing: FileListing, path: string): void => {
    if (
      !this.alive ||
      this.fileLibrary() !== listing ||
      listing.workerId !== this.dependencies.selected() ||
      !listing.files.includes(path)
    ) {
      return;
    }

    this.preview(path);

    if (this.dependencies.modal() === 'files') {
      this.dependencies.setModal('');
    }
  };

  openFileWindow = (id: string, path: string): void => {
    if (!this.alive) {
      return;
    }

    try {
      const url = filePreviewURL(chrome.runtime.getURL('/file.html'), { workerId: id, path });

      void chrome.windows
        .create(fileWindowOptions(url))
        .then(() => {
          if (this.alive) {
            this.dependencies.success('Opened file preview.');
          }
        })
        .catch((error) => {
          if (this.alive) {
            this.dependencies.notice(errorMessage(error));
          }
        });
    } catch (error) {
      this.dependencies.notice(errorMessage(error));
    }
  };

  fileMenu = (id: string, path: string): MenuItem[] => {
    const generation = this.scopeGeneration;
    const isCurrent = () =>
      this.alive && generation === this.scopeGeneration && id === this.dependencies.selected();
    const openIn = (application: string) => {
      if (isCurrent()) {
        void this.dependencies.action('worker.openFile', { workerId: id, path, application });
      }
    };

    return [
      {
        id: 'preview',
        label: 'View file',
        run: () => {
          if (isCurrent()) {
            this.preview(path);
          }
        },
      },
      {
        id: 'window',
        label: 'Preview in new window',
        run: () => {
          if (isCurrent()) {
            this.openFileWindow(id, path);
          }
        },
      },
      { id: 'finder', label: 'Reveal in file manager', separatorBefore: true, run: () => openIn('finder') },
      { id: 'vscode', label: 'Open in VS Code', run: () => openIn('vscode') },
      {
        id: 'copy',
        label: 'Copy relative path',
        separatorBefore: true,
        run: () => {
          if (isCurrent()) {
            void this.dependencies.copy(path);
          }
        },
      },
    ];
  };
}
