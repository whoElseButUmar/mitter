import type { Snapshot, Worker } from '../../../../packages/protocol/src/index.js';
import { displayTaskName } from '../../../../packages/protocol/src/task-brief.js';
import type { BridgeStatus } from '../../../../packages/bridge/src/index.js';
import {
  notificationStorageSchema,
  notificationChangeSchema,
  type NotificationPreferences,
} from '../schemas/messages.js';
import { errorMessage } from '../schemas/primitives.js';

type NotificationDependencies = {
  blocked(): boolean;
  broadcast(message: unknown): void;
  ding(): void;
  openTask(workerId: string): Promise<void>;
  log(kind: string, message: string): void;
};

/** Serializes preference writes and tracks notification writes across the reset barrier. */
export class TaskNotifications {
  private preferences: NotificationPreferences = {
    enabled: false,
    sound: false,
  };
  private tail: Promise<unknown>;
  private writes = new Set<Promise<unknown>>();
  private taskStates = new Map<string, string>();
  private bridgeStates = new Map<string, string>();

  private opening = new Set<string>();
  private revision = 0;
  private disposed = false;

  constructor(private dependencies: NotificationDependencies) {
    const revision = this.revision;
    this.tail = Promise.resolve(chrome.storage.local.get('miter.notifications.v1'))
      .then((stored) => {
        if (this.disposed || this.revision !== revision) {
          return;
        }

        this.preferences = notificationStorageSchema.parse(stored)['miter.notifications.v1'];
      })
      .catch((error) => dependencies.log('notification.settings.error', errorMessage(error)));

    try {
      chrome.notifications?.onClicked.addListener(this.clicked);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private clicked = async (key: string): Promise<void> => {
    if (
      this.disposed ||
      this.dependencies.blocked() ||
      this.opening.has(key) ||
      !key.startsWith('miter-task-')
    ) {
      return;
    }

    const workerId = key.slice('miter-task-'.length);

    if (!workerId) {
      return;
    }

    const revision = this.revision;
    this.opening.add(key);

    try {
      await this.dependencies.openTask(workerId);

      if (this.disposed || this.dependencies.blocked() || this.revision !== revision) {
        return;
      }

      await chrome.notifications.clear(key);
    } catch (error) {
      // Leave the notification available for an explicit retry; never start work.
      this.dependencies.log('notification.open.error', errorMessage(error));
    } finally {
      if (this.revision === revision) {
        this.opening.delete(key);
      }
    }
  };

  private create(workerId: string, title: string, message: string): void {
    if (this.disposed || !this.preferences.enabled || !chrome.notifications) {
      return;
    }

    const id = 'miter-task-' + workerId;
    const revision = this.revision;

    const write = chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title: 'Miter · ' + title,
      message,
      silent: true,
    });
    this.writes.add(write);
    void write
      .then(() => {
        if (
          !this.disposed &&
          this.revision === revision &&
          this.preferences.sound &&
          !this.dependencies.blocked()
        ) {
          this.dependencies.ding();
        }
      })
      .catch((error) => this.dependencies.log('notification.error', errorMessage(error)))
      .finally(() => this.writes.delete(write));
  }

  snapshot(snapshot: Snapshot): void {
    if (this.disposed || this.dependencies.blocked()) {
      return;
    }

    for (const worker of snapshot.workers) {
      let state: string = worker.state;

      if (worker.state === 'complete') {
        state = 'complete';
      } else if (worker.humanAcceptanceReady) {
        state = 'review';
      } else if (worker.state === 'review') {
        state = 'continuing';
      }

      const previous = this.taskStates.get(worker.id);
      this.taskStates.set(worker.id, state);

      if (
        previous === undefined ||
        previous === state ||
        !['complete', 'review', 'blocked', 'awaiting_approval'].includes(state)
      ) {
        continue;
      }

      let title = 'Task needs attention';
      let kind = 'success';

      if (state === 'complete') {
        title = 'Task complete';
      } else if (state === 'review') {
        title = 'Ready for review';
      } else if (state === 'awaiting_approval') {
        title = 'Approval needed';
      }

      if (state === 'blocked' || state === 'awaiting_approval') {
        kind = 'warning';
      }

      this.dependencies.broadcast({
        event: 'taskNotification',
        data: {
          workerId: worker.id,
          kind,
          message: title + ' · ' + displayTaskName(worker),
        },
      });
      this.create(worker.id, title, displayTaskName(worker));
    }
  }

  bridge(status: BridgeStatus, worker?: Worker): void {
    if (this.disposed) {
      return;
    }

    const previous = this.bridgeStates.get(status.workerId);
    const state = status.phase + ':' + status.reason;
    this.bridgeStates.set(status.workerId, state);

    if (this.dependencies.blocked() || status.phase !== 'error' || previous === state) {
      return;
    }

    let name = 'Task';
    let message = status.reason.slice(0, 160);

    if (worker) {
      name = displayTaskName(worker);
    }

    if (status.monitoring) {
      message = 'Check the linked chat. Miter is still watching for its reply.';
    }

    this.dependencies.broadcast({
      event: 'taskNotification',
      data: {
        workerId: status.workerId,
        kind: 'warning',
        message: name + ' needs attention. ' + status.reason,
      },
    });
    this.create(status.workerId, 'Chat needs attention', message);
  }

  async read(): Promise<NotificationPreferences> {
    await this.tail;
    return { ...this.preferences };
  }

  private checkWrite(revision: number): void {
    if (this.disposed || this.dependencies.blocked() || this.revision !== revision) {
      throw new Error(
        'Notification preferences were not saved. Miter is resetting or this request was cancelled; reopen Miter before changing them.',
      );
    }
  }

  set(raw: unknown): Promise<NotificationPreferences> {
    const params = notificationChangeSchema.parse(raw);
    const revision = this.revision;
    const write = this.tail.then(async () => {
      this.checkWrite(revision);

      const next = { ...this.preferences };

      if (params.enabled !== undefined) {
        next.enabled = params.enabled;
      }

      if (params.sound !== undefined) {
        next.sound = params.sound;
      }

      if (next.enabled && !(await chrome.permissions.contains({ permissions: ['notifications'] }))) {
        throw new Error('Desktop notification permission was not granted.');
      }

      this.checkWrite(revision);
      await chrome.storage.local.set({ 'miter.notifications.v1': next });

      if (this.disposed || this.dependencies.blocked() || this.revision !== revision) {
        return { ...next };
      }

      this.preferences = next;
      this.dependencies.broadcast({
        event: 'notificationSettings',
        data: next,
      });
      return { ...next };
    });
    this.tail = write.then(
      () => {},
      () => {},
    );
    return write;
  }

  async quiesce(): Promise<void> {
    await this.tail;
    await Promise.allSettled([...this.writes]);
  }

  clear(): void {
    this.revision++;
    this.preferences = { enabled: false, sound: false };
    this.taskStates.clear();
    this.bridgeStates.clear();

    this.opening.clear();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clear();

    try {
      chrome.notifications?.onClicked.removeListener(this.clicked);
    } catch (error) {
      console.warn('Miter notification listener could not be detached.', error);
    }
  }
}
