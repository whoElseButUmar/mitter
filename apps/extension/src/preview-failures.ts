import type { TaskBoundary } from '../../../packages/protocol/src/index.js';

// Failures belong to one exact launch. A later run and a different Chrome
// profile must never inherit another task's alert.
function key(workerId: string, run: TaskBoundary): string {
  return 'miter.previewOpenFailure.' + JSON.stringify([workerId, run.runId, run.epoch]);
}

function failureMessage(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.slice(0, 600).replace('Use Open preview to try again.', 'Choose Run to retry in Terminal.');
}

export const previewFailures = {
  async read(workerId: string, run: TaskBoundary): Promise<string> {
    const name = key(workerId, run);
    const stored = await chrome.storage.session.get(name);
    return failureMessage(stored[name]);
  },
  subscribe(workerId: string, run: TaskBoundary, update: (message: string) => void): () => void {
    const name = key(workerId, run);
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && Object.hasOwn(changes, name)) {
        update(failureMessage(changes[name]?.newValue));
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  },
  async save(workerId: string, run: TaskBoundary, message: string): Promise<void> {
    await chrome.storage.session.set({ [key(workerId, run)]: message.slice(0, 600) });
  },
  async clear(workerId: string, run: TaskBoundary): Promise<void> {
    await chrome.storage.session.remove(key(workerId, run));
  },
};
