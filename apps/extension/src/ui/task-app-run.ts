import { createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';
import type { Worker } from '../../../../packages/protocol/src/index';
import { assetChunkSchema, previewStartResultSchema } from '../../../../packages/protocol/src/rpc';
import type { previewFailures } from '../preview-failures';
import { errorMessage } from '../schemas/primitives';
import { callResult, type ViewRPC } from './rpc';
import { reviewedTaskBoundary } from './task-boundary';

export function createTaskAppRun(options: {
  task: () => Worker;
  connected: () => boolean;
  rpc: ViewRPC;
  showTerminal: (task: Worker) => (message: string) => void;
  failures?: Pick<typeof previewFailures, 'read' | 'clear' | 'subscribe'>;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [autoError, setAutoError] = createSignal('');
  const [hasEntry, setHasEntry] = createSignal(false);
  const scope = createMemo(() => {
    const task = options.task();
    return JSON.stringify([task.id, task.runId, task.control?.epoch ?? 0]);
  });
  const ready = createMemo(() => options.task().state === 'complete' && !options.task().pending);
  const autoPreview = createMemo(() => {
    const evidence = options.task().completion?.evidence;
    return !!(evidence?.devServer || evidence?.staticPreview);
  });
  const knownApp = createMemo(
    () => autoPreview() || options.task().completion?.evidence?.browser === 'passed',
  );
  const available = () => ready() && (knownApp() || hasEntry());
  let revision = 0;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  createEffect(() => {
    scope();
    const eligible = ready();
    const connected = options.connected();
    setBusy(false);
    setError('');
    setAutoError('');
    setHasEntry(false);
    onCleanup(() => {
      revision++;
    });
    if (!eligible || !connected) {
      return;
    }
    const task = untrack(options.task);
    const current = revision;
    if (!knownApp()) {
      // Earlier completions may have kept an existing entry outside the task's edits.
      void callResult(options.rpc, assetChunkSchema, 'worker.asset', {
        workerId: task.id,
        path: 'index.html',
        length: 1,
      })
        .then((entry) => {
          if (current === revision) {
            setHasEntry(entry.path === 'index.html' && entry.size > 0);
          }
        })
        .catch(() => {});
    }
    if (autoPreview() && options.failures) {
      const run = reviewedTaskBoundary(task);
      let changed = false;
      onCleanup(
        options.failures.subscribe(task.id, run, (message) => {
          changed = true;
          setAutoError(message);
        }),
      );
      void options.failures
        .read(task.id, run)
        .then((message) => {
          if (current === revision && !changed) {
            setAutoError(message);
          }
        })
        .catch(() => {});
    }
  });

  const start = async () => {
    if (disposed || busy() || !options.connected() || !available()) {
      return;
    }
    const task = options.task();
    const current = revision;
    let reportFailure: ((message: string) => void) | undefined;
    setBusy(true);
    setError('');
    try {
      const expectedRun = reviewedTaskBoundary(task);
      reportFailure = options.showTerminal(task);
      await callResult(options.rpc, previewStartResultSchema, 'worker.previewStart', {
        workerId: task.id,
        expectedRun,
        mode: 'run',
      });
      // The host owns the session even if the user switches tasks during startup.
      await options.failures?.clear(task.id, expectedRun).catch(() => {});
      if (current === revision) {
        setAutoError('');
      }
    } catch (failure) {
      const message = errorMessage(failure);
      reportFailure?.(message);
      if (current === revision) {
        setError(message);
      }
    } finally {
      if (current === revision) {
        setBusy(false);
      }
    }
  };
  return { available, busy, error: () => error() || autoError(), start };
}
