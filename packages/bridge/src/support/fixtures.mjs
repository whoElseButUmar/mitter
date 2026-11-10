export const worker = {
  id: 'worker_1',
  projectId: 'project_1',
  state: 'idle',
  checks: [],
};
export const reply = {
  protocol: 'mitter/1',
  id: 'reply_1',
  workerId: worker.id,
  projectId: worker.projectId,
  summary: 'Inspect files',
  actions: [{ type: 'list', path: '.' }],
};
export const chatLink = {
  id: 7,
  url: 'https://chatgpt.com/c/task-1',
  title: 'Task chat',
  newChat: false,
};

export function chatView(overrides = {}) {
  return {
    url: 'https://chatgpt.com/c/task-1',
    count: 1,
    userCount: 1,
    assistantId: '',
    lastRole: 'user',
    lastUserText: 'Sent prompt',
    assistantText: '',
    busy: false,
    complete: false,
    draft: false,
    draftText: '',
    stopped: false,
    ready: true,
    ...overrides,
  };
}
