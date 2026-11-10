export function chromeEvent() {
  const listeners = new Set();

  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) {
        listener(...args);
      }
    },
    get size() {
      return listeners.size;
    },
  };
}

export function mockPort(name = 'mitter-ui', url = 'chrome-extension://extension/workspace.html') {
  const port = {
    name,
    sender: { id: 'extension', frameId: 0, origin: 'chrome-extension://extension', url },
    onMessage: chromeEvent(),
    onDisconnect: chromeEvent(),
    messages: [],
    disconnects: 0,
    postMessage(message) {
      port.messages.push(message);
    },
    disconnect() {
      port.disconnects++;
      port.onDisconnect.emit();
    },
  };

  return port;
}

export function deferred() {
  const callbacks = {};
  const promise = new Promise((resolve, reject) => {
    callbacks.resolve = resolve;
    callbacks.reject = reject;
  });

  return { promise, ...callbacks };
}

export async function settle() {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve();
  }
}

export const snapshot = {
  protocol: 'mitter/1',
  projects: [],
  workers: [],
  events: [],
  settings: { coderModelPath: '', contextSize: 8192, maxTokens: 1024, gpu: 'auto' },
  runtime: { version: '1.0.0-rc.21', node: 'test', workflow: 'test', models: 'test' },
};

export const terminalInfo = {
  id: 'session',
  projectId: 'project',
  title: 'Shell',
  cwd: '/project',
  shell: '/bin/sh',
  pid: 1,
  cols: 80,
  rows: 24,
  createdAt: 0,
  exited: false,
  owned: true,
  occupied: false,
  paused: false,
};

export const assetChunk = {
  path: 'index.html',
  mime: 'text/html',
  size: 3,
  offset: 0,
  stamp: 'a'.repeat(64),
  data: 'YWJj',
  eof: true,
};
