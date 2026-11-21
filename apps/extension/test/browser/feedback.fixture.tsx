import { onCleanup, type JSX } from 'solid-js';
import { FileViewer } from '../../src/FileViewer';
import { NotificationsSettings } from '../../src/forms/NotificationsForm';
import { ToastCenter, mountToasts } from '../../../../packages/ui/src/toast';
import { notificationPreferencesSchema } from '../../src/schemas/messages';
import { TaskAttentionFixture } from './task-attention.fixture';

function deferred() {
  let callbacks: { resolve: (value: unknown) => void; reject: (reason: Error) => void } | undefined;
  const promise = new Promise<unknown>((resolve, reject) => {
    callbacks = { resolve, reject };
  });
  if (!callbacks) {
    throw new Error('Controlled feedback response is unavailable.');
  }
  return { promise, ...callbacks };
}

/** Real feedback views with controlled reads and preferences; no host or desktop permission is used. */
export function createFeedbackFixture(mount: (component: () => JSX.Element) => void) {
  const reads: ReturnType<typeof deferred>[] = [];
  const saves: { response: ReturnType<typeof deferred>; enabled: boolean; sound: boolean }[] = [];
  const preferenceReads: ReturnType<typeof deferred>[] = [];
  const notices: string[] = [];
  const outputReads: { method: string; response: ReturnType<typeof deferred> }[] = [];
  let center: ToastCenter | undefined;
  let toastAction: ReturnType<typeof deferred> | undefined;
  let actionCalls = 0;
  let closed = 0;

  function showFile() {
    mount(() => (
      <FileViewer
        workerId="feedback_worker"
        path="notes.txt"
        rpc={(method) => {
          if (method !== 'worker.asset') {
            throw new Error('Unexpected feedback request: ' + method);
          }
          const response = deferred();
          reads.push(response);
          return response.promise;
        }}
        request={async () => {
          throw new Error('Feedback checks must not change project files.');
        }}
        notice={(message) => notices.push(message)}
        copy={async () => {}}
        openWindow={() => {}}
      />
    ));
  }

  function finishFile(index: number, text = 'Saved project notes.', failure = '') {
    const response = reads[index];
    if (!response) {
      throw new Error('No file request at index ' + index);
    }
    if (failure) {
      response.reject(new Error(failure));
      return;
    }
    response.resolve({
      path: 'notes.txt',
      mime: 'text/plain',
      size: new TextEncoder().encode(text).length,
      offset: 0,
      stamp: 'a'.repeat(64),
      data: btoa(text),
      eof: true,
    });
  }

  function showNotifications() {
    mount(() => {
      const toasts = new ToastCenter();
      center = toasts;
      onCleanup(mountToasts(document, toasts));
      onCleanup(() => {
        center = undefined;
      });
      return (
        <NotificationsSettings
          rpc={async (method, params) => {
            if (method === 'notifications.get') {
              const response = deferred();
              preferenceReads.push(response);
              return response.promise;
            }
            if (method !== 'notifications.set') {
              throw new Error('Unexpected preferences request: ' + method);
            }
            const preferences = notificationPreferencesSchema.parse(params);
            const response = deferred();
            saves.push({ response, ...preferences });
            return response.promise;
          }}
          close={() => {
            closed++;
            mount(() => <p>Notification settings closed.</p>);
          }}
          success={(message) => notices.push(message)}
          playSound={async () => {
            notices.push('sound');
          }}
        />
      );
    });
  }

  function showOutput() {
    mount(() => (
      <TaskAttentionFixture
        reason=""
        receiving={false}
        consoleOpen={false}
        workerError=""
        scenario="unverified"
        onAction={(name) => notices.push(name)}
        outputRead={(method) => {
          if (method !== 'worker.files' && method !== 'worker.history') {
            throw new Error('Unexpected output read: ' + method);
          }
          const response = deferred();
          outputReads.push({ method, response });
          return response.promise;
        }}
      />
    ));
  }

  function notify(message: string, failure = false, action = false) {
    if (!center) {
      throw new Error('Mount notification preferences before sending fixture feedback.');
    }
    let kind: 'info' | 'error' = 'info';
    if (failure) {
      kind = 'error';
    }
    const notification = { message, kind, key: 'feedback', duration: 60000 };
    if (!action) {
      return center.push(notification);
    }
    return center.push({
      ...notification,
      action: {
        label: 'Try again',
        run: () => {
          actionCalls++;
          toastAction = deferred();
          return toastAction.promise;
        },
      },
    });
  }

  return {
    showFile,
    finishFile,
    showNotifications,
    showOutput,
    notify,
    finishNotification(failure = '') {
      if (failure) {
        toastAction?.reject(new Error(failure));
      } else {
        toastAction?.resolve(undefined);
      }
    },
    finishSave(index: number, failure = '') {
      const save = saves[index];
      if (!save) {
        throw new Error('No preference save at index ' + index);
      }
      if (failure) {
        save.response.reject(new Error(failure));
      } else {
        save.response.resolve({ enabled: save.enabled, sound: save.sound });
      }
    },
    finishPreferences(index: number, failure = '') {
      const response = preferenceReads[index];
      if (!response) {
        throw new Error('No preference read at index ' + index);
      }
      if (failure) {
        response.reject(new Error(failure));
      } else {
        response.resolve({ enabled: false, sound: true });
      }
    },
    finishOutput(index: number, failure = '') {
      const read = outputReads[index];
      if (!read) {
        throw new Error('No output read at index ' + index);
      }
      if (failure) {
        read.response.reject(new Error(failure));
      } else if (read.method === 'worker.files') {
        read.response.resolve([]);
      } else {
        read.response.resolve({ events: [], hasMore: false, before: null });
      }
    },
    inspect: () => ({
      reads: reads.length,
      outputReads: outputReads.map(({ method }) => method),
      saves: saves.map(({ enabled, sound }) => ({ enabled, sound })),
      preferenceReads: preferenceReads.length,
      notices: [...notices],
      actionCalls,
      closed,
    }),
  };
}
