import {
  WORKSPACE_KEY,
  LEGACY_WORKSPACE_KEY,
  restoreWorkspace,
  reconcileWorkspace,
  reduceWorkspace,
  validateWorkspaceAction,
  type WorkspaceState,
  type Catalog,
} from './workspace.js';
import { StorageValuesSchema } from './workspace/schemas.js';

export type WorkspaceStorage = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<unknown>;
};

/** A single background authority serializes actions from every UI view. A failed
 * durable write is reported, not broadcast as though the action had succeeded. */
export class WorkspaceStore {
  private stopped = false;
  private state: WorkspaceState | undefined;
  private stored: Record<string, unknown> | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private backend: WorkspaceStorage,
    private publish: (state: WorkspaceState) => void,
  ) {}

  private queue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => {
      if (this.stopped) {
        throw new Error('Data reset in progress.');
      }

      return job();
    });
    this.tail = next.catch(() => {});
    return next;
  }

  private async load(catalog: Catalog): Promise<WorkspaceState> {
    let stored = this.stored;

    if (!stored) {
      stored = StorageValuesSchema.parse(
        await this.backend.get([WORKSPACE_KEY, LEGACY_WORKSPACE_KEY, 'selectedWorker']),
      );
      this.stored = stored;
    }

    return (
      this.state ??
      restoreWorkspace(stored[WORKSPACE_KEY], stored[LEGACY_WORKSPACE_KEY], stored.selectedWorker, catalog)
    );
  }

  private async save(next: WorkspaceState): Promise<WorkspaceState> {
    const previous = this.state;
    const changed = !previous || JSON.stringify(next) !== JSON.stringify(previous);

    if (changed) {
      next = {
        ...next,
        revision: Math.max(previous?.revision || 0, next.revision) + 1,
      };
      await this.backend.set({ [WORKSPACE_KEY]: next });
      this.state = next;
      this.publish(next);
      return structuredClone(next);
    }

    return structuredClone(next);
  }

  sync(catalog: Catalog): Promise<WorkspaceState> {
    return this.queue(async () => this.save(reconcileWorkspace(await this.load(catalog), catalog)));
  }

  dispatch(value: unknown, catalog: Catalog): Promise<WorkspaceState> {
    const action = validateWorkspaceAction(value);
    return this.queue(async () =>
      this.save(reduceWorkspace(await this.load(catalog), action, catalog, Date.now(), crypto.randomUUID())),
    );
  }

  async quiesce(): Promise<void> {
    this.stopped = true;
    await this.tail;
  }

  peek(): WorkspaceState | undefined {
    if (this.state) {
      return structuredClone(this.state);
    }

    return undefined;
  }
}
