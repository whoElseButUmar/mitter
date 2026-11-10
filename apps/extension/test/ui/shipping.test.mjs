import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createRoot, createSignal } from 'solid-js';
import { projectSchema } from '../../../../packages/protocol/src/index.ts';
import {
  createProjectDraft,
  createContextDraft,
  createNotificationsDraft,
} from '../../src/ui/dialog-forms.ts';
import { createTeamUpdates } from '../../src/ui/team-updates.ts';
import { createFilePreview } from '../../src/ui/file-preview.ts';
import { createWorkspaceController } from '../../src/ui/workspace-controller.ts';
import { syncInputValidity } from '../../src/ui/dom.ts';
import { HostClient } from '../../src/client.ts';
import { emptyWorkspace } from '../../../../packages/ui/src/workspace.ts';
import { domFixture } from '../../../../packages/ui/test/dom-fixture.mjs';
import { assetChunk, flush, waitFor, worker, bridge, control, admittedChat } from './fixtures.mjs';
import { ToastCenter } from '../../../../packages/ui/src/toast.ts';
import { MAX_HANDOFF_BYTES } from '../../../../packages/protocol/src/reply-json.ts';
import { reviewedTaskBoundary } from '../../src/ui/task-boundary.ts';
import { createWorkerFormRequests, startCreatedTask } from '../../src/forms/WorkerForm.tsx';
import { createAutomationFormRequests } from '../../src/AutomationForm.tsx';

const project = projectSchema.parse({
  id: 'project_a',
  name: 'Project A',
  root: '/project-a',
  profiles: [],
  revision: 1,
});
const workerLifecycle = {
  rpc: async (method) => assert.fail('Unexpected task cleanup RPC: ' + method),
  stop: async () => assert.fail('Unexpected local task cleanup.'),
  close: () => assert.fail('Unexpected task dialog close.'),
  failed: (error) => assert.fail('Unexpected task start failure: ' + error),
};
const emptyTeam = { peers: [], messages: [] };
const populatedTeam = {
  peers: [],
  messages: [
    {
      id: 'message_1',
      projectId: 'project_a',
      from: 'worker_a',
      time: 1,
      message: 'A project update',
      kind: 'message',
    },
  ],
};

function projectOwner(overrides = {}) {
  return createRoot((dispose) => ({
    dispose,
    draft: createProjectDraft({
      close: () => {},
      pick: async () => ({ cancelled: true }),
      save: async () => project,
      opened: () => {},
      ...overrides,
    }),
  }));
}

for (const operation of ['choose', 'save']) {
  for (const dismissal of ['close', 'dispose']) {
    for (const outcome of ['success', 'failure']) {
      test(
        'project ' + operation + ' late ' + outcome + ' cannot affect a replacement after ' + dismissal,
        async () => {
          const pending = Promise.withResolvers();
          const opened = [];
          let modal = 'project';
          const owner = projectOwner({
            close: () => {
              modal = '';
            },
            pick: () => pending.promise,
            save: () => pending.promise,
            opened: (added) => opened.push(added),
          });
          owner.draft.setRoot('/original');
          owner.draft.setName('Original');
          const working = owner.draft[operation]();
          if (dismissal === 'close') {
            owner.draft.close();
          } else {
            owner.dispose();
          }
          modal = 'replacement';

          if (outcome === 'failure') {
            pending.reject(new Error('Old operation failed.'));
          } else if (operation === 'choose') {
            pending.resolve({ cancelled: false, root: '/late-folder' });
          } else {
            pending.resolve(project);
          }
          await working;

          assert.equal(modal, 'replacement');
          assert.equal(owner.draft.root(), '/original');
          assert.equal(owner.draft.name(), 'Original');
          assert.equal(owner.draft.error(), '');
          assert.equal(owner.draft.busy(), false);
          assert.deepEqual(opened, []);
          owner.dispose();
        },
      );
    }
  }
}

test('a pending folder choice cannot overwrite subsequent manual path or name edits', async () => {
  const pending = Promise.withResolvers();
  const owner = projectOwner({ pick: () => pending.promise });
  try {
    const choosing = owner.draft.choose();
    owner.draft.setRoot('/typed-after-picker-opened');
    owner.draft.setName('Manually named');
    pending.resolve({ cancelled: false, root: '/late-folder' });
    await choosing;
    assert.equal(owner.draft.root(), '/typed-after-picker-opened');
    assert.equal(owner.draft.name(), 'Manually named');
  } finally {
    owner.dispose();
  }
});

test('project save captures its fields, prevents overlapping submits, and reports success once', async () => {
  const pending = Promise.withResolvers();
  const calls = [];
  const opened = [];
  let closes = 0;
  const owner = projectOwner({
    save: (fields) => {
      calls.push(fields);
      return pending.promise;
    },
    opened: (added) => opened.push(added),
    close: () => {
      closes++;
    },
  });
  try {
    owner.draft.setRoot(project.root);
    owner.draft.setName(project.name);
    const first = owner.draft.save();
    const duplicate = owner.draft.save();
    owner.draft.setRoot('/new-draft');
    pending.resolve(project);
    await Promise.all([first, duplicate]);
    assert.deepEqual(calls, [{ name: project.name, root: project.root }]);
    assert.deepEqual(opened, [project]);
    assert.equal(closes, 1);
    assert.equal(owner.draft.busy(), false);
  } finally {
    owner.dispose();
  }
});

function teamOwner() {
  const reads = [];
  const sends = [];
  const successes = [];
  return createRoot((dispose) => {
    const [workerId, setWorkerId] = createSignal('worker_a');
    const [revision, setRevision] = createSignal(1);
    const updates = createTeamUpdates({
      get workerId() {
        return workerId();
      },
      get revision() {
        return revision();
      },
      rpc(method, params) {
        const pending = Promise.withResolvers();
        const call = { params, ...pending };
        if (method === 'worker.team') {
          reads.push(call);
        } else {
          assert.equal(method, 'worker.teamMessage');
          sends.push(call);
        }
        return pending.promise;
      },
      success: (message) => successes.push(message),
    });
    return { dispose, updates, setWorkerId, setRevision, reads, sends, successes };
  });
}

async function finishTeamReads(owner) {
  await flush();
  for (const read of owner.reads) {
    read.resolve(emptyTeam);
  }
  await flush();
}

test('team navigation immediately clears the prior project list and draft; stale reads stay fenced', async () => {
  const owner = teamOwner();
  try {
    owner.reads[0].resolve(populatedTeam);
    await flush();
    owner.updates.setText('A draft');
    owner.setWorkerId('worker_b');
    assert.deepEqual(owner.updates.data(), emptyTeam);
    assert.equal(owner.updates.text(), '');
    assert.equal(owner.reads[1].params.workerId, 'worker_b');
    owner.setWorkerId('worker_a');
    owner.reads[1].resolve(populatedTeam);
    owner.reads[2].resolve(emptyTeam);
    await flush();
    assert.deepEqual(owner.updates.data(), emptyTeam);
  } finally {
    owner.dispose();
  }
});

for (const outcome of ['success', 'failure']) {
  test('late team send ' + outcome + ' cannot clear a replacement worker draft or busy state', async () => {
    const owner = teamOwner();
    try {
      await finishTeamReads(owner);
      owner.updates.setText('Update for A');
      const oldSend = owner.updates.send();
      owner.setWorkerId('worker_b');
      await finishTeamReads(owner);
      owner.updates.setText('Update for B');
      const newSend = owner.updates.send();
      if (outcome === 'failure') {
        owner.sends[0].reject(new Error('A acknowledgement failed.'));
      } else {
        owner.sends[0].resolve({ ok: true, note: 'Shared.' });
      }
      await finishTeamReads(owner);
      await oldSend;

      assert.equal(owner.updates.text(), 'Update for B');
      assert.equal(owner.updates.busy(), true);
      assert.equal(owner.updates.error(), '');
      assert.equal(owner.reads.length, 2, 'old sends must not refresh a replacement worker');
      assert.deepEqual(owner.successes, []);
      owner.sends[1].resolve({ ok: true, note: 'Shared.' });
      await finishTeamReads(owner);
      await newSend;
      assert.equal(owner.updates.text(), '');
      assert.equal(owner.updates.busy(), false);
      assert.equal(owner.successes.length, 1);
    } finally {
      owner.dispose();
    }
  });
}

test('team send does not discard text edited while its acknowledgement is pending', async () => {
  const owner = teamOwner();
  try {
    await finishTeamReads(owner);
    owner.updates.setText('Submitted update');
    const sending = owner.updates.send();
    owner.updates.setText('Next update draft');
    owner.sends[0].resolve({ ok: true, note: 'Shared.' });
    await finishTeamReads(owner);
    await sending;
    assert.equal(owner.updates.text(), 'Next update draft');
    assert.equal(owner.updates.busy(), false);
    assert.equal(owner.sends[0].params.message, 'Submitted update');
  } finally {
    owner.dispose();
  }
});

for (const outcome of ['success', 'failure']) {
  test('disposed team send ' + outcome + ' cannot notify, reload, or retain team state', async () => {
    const owner = teamOwner();
    owner.reads[0].resolve(populatedTeam);
    await flush();
    owner.updates.setText('Submitted update');
    const sending = owner.updates.send();
    owner.dispose();
    if (outcome === 'failure') {
      owner.sends[0].reject(new Error('Old acknowledgement failed.'));
    } else {
      owner.sends[0].resolve({ ok: true, note: 'Shared.' });
    }
    await finishTeamReads(owner);
    await sending;
    assert.deepEqual(owner.updates.data(), emptyTeam);
    assert.equal(owner.updates.text(), '');
    assert.equal(owner.updates.busy(), false);
    assert.equal(owner.updates.error(), '');
    assert.equal(owner.reads.length, 1);
    assert.deepEqual(owner.successes, []);
  });
}

for (const acknowledgement of [null, undefined, {}, { ok: true }, { ok: 'true', note: 'Shared.' }]) {
  test('malformed team acknowledgement cannot clear the draft, report success, refresh, or replay', async () => {
    const owner = teamOwner();
    try {
      await finishTeamReads(owner);
      owner.updates.setText('Keep this unconfirmed update');
      const sending = owner.updates.send();
      owner.sends[0].resolve(acknowledgement);
      await sending;
      await flush();
      assert.equal(owner.updates.text(), 'Keep this unconfirmed update');
      assert.equal(owner.updates.busy(), false);
      assert.match(owner.updates.error(), /invalid result|confirm|Check|check/);
      assert.deepEqual(owner.successes, []);
      assert.equal(owner.reads.length, 1);
      assert.equal(owner.sends.length, 1);
    } finally {
      owner.dispose();
    }
  });
}

test('team read failure can be retried safely and successful refresh clears its error', async () => {
  const owner = teamOwner();
  try {
    owner.reads[0].reject(new Error('Team read failed.'));
    await flush();
    assert.match(owner.updates.error(), /Team read failed/);
    const retry = owner.updates.load();
    owner.reads[1].resolve(populatedTeam);
    await retry;
    assert.deepEqual(owner.updates.data(), populatedTeam);
    assert.equal(owner.updates.error(), '');
    assert.equal(owner.sends.length, 0);
  } finally {
    owner.dispose();
  }
});

test('team duplicate submit is blocked and failed acknowledgement is not automatically replayed', async () => {
  const owner = teamOwner();
  try {
    await finishTeamReads(owner);
    owner.updates.setText('Only one update');
    const sending = owner.updates.send();
    const duplicate = owner.updates.send();
    owner.sends[0].reject(new Error('Lost acknowledgement.'));
    if (owner.sends[1]) {
      owner.sends[1].reject(new Error('Duplicate acknowledgement.'));
    }
    await Promise.all([sending, duplicate]);
    assert.equal(owner.sends.length, 1);
    assert.equal(owner.updates.text(), 'Only one update');
    assert.match(owner.updates.error(), /already|confirm|Check|check/);
    const retry = owner.updates.load();
    owner.reads.at(-1).resolve(populatedTeam);
    await retry;
    assert.equal(owner.sends.length, 1, 'retrying a read must not replay a mutation');
  } finally {
    owner.dispose();
  }
});

for (const form of ['context', 'notifications']) {
  test(form + ' failures are retained in the owning dialog, not only a global notice', async () => {
    const notices = [];
    const options = {
      close: () => assert.fail('A failed save must leave the dialog open.'),
      success: () => assert.fail('A failed save must not report success.'),
      notice: (message) => notices.push(message),
      rpc: async () => {
        throw new Error('Settings save failed.');
      },
    };
    const owner = createRoot((dispose) => {
      let draft;
      if (form === 'context') {
        draft = createContextDraft({ ...options, project: () => project, projects: () => [project] });
      } else {
        draft = createNotificationsDraft({ ...options, preferences: { enabled: false, sound: false } });
      }
      return { dispose, draft };
    });
    try {
      await owner.draft.save();
      assert.equal(owner.draft.error(), 'Settings save failed.');
      assert.deepEqual(notices, ['Settings save failed.']);
      assert.equal(owner.draft.busy(), false);
    } finally {
      owner.dispose();
    }
  });
}

test('disposed completed previews release asset bytes, document text, hashes, URLs and warning state', async (context) => {
  const revoked = [];
  const revoke = URL.revokeObjectURL.bind(URL);
  context.mock.method(URL, 'revokeObjectURL', (url) => {
    revoked.push(url);
    revoke(url);
  });
  const owner = createRoot((dispose) => ({
    dispose,
    preview: createFilePreview({
      workerId: 'worker_a',
      path: 'readme.md',
      rpc: async () => assetChunk('readme.md', '# Project notes', 'text/markdown'),
    }),
  }));
  await waitFor(() => !owner.preview.loading(), 'the completed markdown preview');
  assert.ok(owner.preview.asset());
  assert.ok(owner.preview.source());
  assert.ok(owner.preview.html());
  assert.ok(owner.preview.hash());
  const url = owner.preview.url();
  owner.dispose();

  assert.deepEqual(revoked, [url]);
  assert.equal(owner.preview.asset(), undefined);
  assert.equal(owner.preview.source(), '');
  assert.equal(owner.preview.html(), '');
  assert.equal(owner.preview.hash(), '');
  assert.equal(owner.preview.url(), '');
  assert.deepEqual(owner.preview.warnings(), []);
  assert.equal(owner.preview.loading(), false);
});

function workspaceOwner(context, options = {}) {
  const fixture = domFixture();
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fixture.document });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { search: '' } });
  const reads = [];
  const notices = [];
  const push = ToastCenter.prototype.push;
  context.mock.method(ToastCenter.prototype, 'push', function (input) {
    notices.push(input);
    return push.call(this, input);
  });
  context.mock.method(HostClient.prototype, 'connect', function () {
    if (options.bridges) {
      this.onAux({ event: 'bridges', data: options.bridges });
    }
  });
  context.mock.method(HostClient.prototype, 'request', (method, params) => {
    if (method === 'workspace.read') {
      return Promise.resolve(emptyWorkspace());
    }
    const pending = Promise.withResolvers();
    reads.push({ method, params, ...pending });
    return pending.promise;
  });
  const owner = createRoot((dispose) => ({ dispose, controller: createWorkspaceController() }));
  owner.controller.setSnapshot((snapshot) => ({
    ...snapshot,
    projects: [project],
    workers: [
      worker({ id: 'worker_a', projectId: project.id }),
      worker({ id: 'worker_b', projectId: project.id }),
    ],
  }));
  context.after(() => {
    owner.dispose();
    if (previousDocument) {
      Object.defineProperty(globalThis, 'document', previousDocument);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
    if (previousLocation) {
      Object.defineProperty(globalThis, 'location', previousLocation);
    } else {
      Reflect.deleteProperty(globalThis, 'location');
    }
  });
  const navigate = (workerId, revision) =>
    owner.controller.applyNavigation({
      ...emptyWorkspace(),
      revision,
      projectId: 'project_a',
      taskByProject: { project_a: workerId },
    });
  return { ...owner, ...fixture, reads, notices, navigate };
}

for (const action of [
  { name: 'prompt', run: (controller) => controller.showText('bootstrap'), result: 'Old setup prompt' },
  { name: 'report', run: (controller) => controller.showText('report'), result: 'Old report' },
  { name: 'resend', run: (controller) => controller.showResend(), result: 'Old resend prompt' },
  { name: 'followups', run: (controller) => controller.showFollowups(), result: [] },
]) {
  test(
    'late ' + action.name + ' dialog read is rejected after navigation leaves and returns to the same task',
    async (context) => {
      const owner = workspaceOwner(context);
      await flush();
      owner.navigate('worker_a', 1);
      const opening = action.run(owner.controller);
      assert.equal(owner.reads.length, 1);
      owner.navigate('worker_b', 2);
      owner.navigate('worker_a', 3);
      owner.reads[0].resolve(action.result);
      await opening;

      assert.equal(owner.controller.modal(), '');
      assert.equal(owner.controller.textValue(), '');
      assert.deepEqual(owner.controller.followupHistory(), []);
    },
  );
}

for (const outcome of ['success', 'failure']) {
  test(
    'late settings dialog read ' + outcome + ' cannot replace or report into a newer dialog',
    async (context) => {
      const owner = workspaceOwner(context);
      await flush();
      const opening = owner.controller.showNotifications();
      owner.controller.setModal('project');
      if (outcome === 'success') {
        owner.reads[0].resolve({ enabled: true, sound: true });
      } else {
        owner.reads[0].reject(new Error('Old settings read failed.'));
      }
      await opening;

      assert.equal(owner.controller.modal(), 'project');
      assert.deepEqual(owner.controller.notifications(), { enabled: false, sound: false });
      assert.doesNotMatch(owner.document.body.textContent, /Old settings read failed/);
    },
  );
}

test('concurrent dialog reads apply only the latest intent and disposal rejects late results', async (context) => {
  const owner = workspaceOwner(context);
  await flush();
  owner.navigate('worker_a', 1);
  const first = owner.controller.showText('bootstrap');
  const second = owner.controller.showText('report');
  owner.reads[1].resolve('Current report');
  await second;
  owner.reads[0].resolve('Older setup prompt');
  await first;
  assert.equal(owner.controller.modal(), 'report');
  assert.equal(owner.controller.textValue(), 'Current report');

  owner.controller.setModal('');
  const disposed = owner.controller.showResend();
  owner.dispose();
  owner.reads[2].resolve('Disposed prompt');
  await disposed;
  assert.equal(owner.controller.modal(), '');
  assert.equal(owner.controller.textValue(), 'Current report');
});

test('dialog read scope ignores repeated snapshots but remembers another dialog opening and closing', async (context) => {
  const owner = workspaceOwner(context);
  await flush();
  owner.navigate('worker_a', 1);
  const reading = owner.controller.showResend();
  owner.navigate('worker_a', 1);
  owner.reads[0].resolve('Current prompt');
  await reading;
  assert.equal(owner.controller.modal(), 'resend');
  assert.equal(owner.controller.textValue(), 'Current prompt');

  owner.controller.setModal('');
  const obsolete = owner.controller.showNotifications();
  owner.controller.setModal('project');
  owner.controller.setModal('');
  owner.reads[1].resolve({ enabled: true, sound: true });
  await obsolete;
  assert.equal(owner.controller.modal(), '');
  assert.deepEqual(owner.controller.notifications(), { enabled: false, sound: false });
});

function handoffText(id = 'batch_a') {
  return JSON.stringify({
    protocol: 'mitter/1',
    id,
    workerId: 'worker_a',
    projectId: 'project_a',
    summary: 'The exact reviewed batch',
    actions: [{ type: 'command', profileId: 'test' }],
  });
}

async function actionOwner(
  context,
  taskOverrides = {},
  bridges = [bridge({ workerId: 'worker_a' }), bridge({ workerId: 'worker_b' })],
) {
  const owner = workspaceOwner(context, { bridges });
  await flush();
  owner.controller.setSnapshot((snapshot) => ({
    ...snapshot,
    projects: [project],
    workers: [
      worker({ id: 'worker_a', projectId: project.id, state: 'paused', ...taskOverrides }),
      worker({ id: 'worker_b', projectId: project.id, state: 'paused' }),
    ],
  }));
  owner.navigate('worker_a', 1);
  return owner;
}

async function startWorkspaceAction(owner, phase) {
  const controller = owner.controller;
  let completion;
  if (phase === 'resend') {
    const opening = controller.showResend();
    owner.reads.at(-1).resolve('Exact pending prompt');
    await opening;
    completion = controller.resendPending();
    await flush();
    if (owner.reads.at(-1).method === 'bridge.lastPrompt') {
      owner.reads.at(-1).resolve('Exact pending prompt');
      await flush();
    }
  } else if (phase === 'import' || phase === 'import run') {
    controller.setModal('import');
    controller.setHandoff(handoffText());
    completion = controller.importBatch();
    await waitFor(() => owner.reads.at(-1)?.method === 'worker.import', 'the exact import request');
    if (phase === 'import run') {
      owner.reads.at(-1).resolve({ queued: true });
      await waitFor(() => owner.reads.at(-1)?.method === 'worker.run', 'the accepted batch start');
    }
  } else if (phase === 'pending chat' || phase === 'pending local') {
    completion = controller.continuePending();
    assert.equal(owner.reads.at(-1).method, 'bridge.continuePending');
  } else {
    completion = controller.runWithChat();
  }
  return { completion, request: owner.reads.at(-1) };
}

for (const phase of [
  'resend',
  'import',
  'import run',
  'pending chat',
  'pending local',
  'chat resume',
  'fresh',
]) {
  for (const dismissal of ['cancel', 'replacement', 'dispose', 'A-to-B-to-A']) {
    for (const outcome of ['success', 'failure']) {
      test(phase + ' late ' + outcome + ' retains ownership after ' + dismissal, async (context) => {
        let overrides = {};
        if (phase === 'fresh') {
          overrides = { control: control('stopped') };
        }
        const owner = await actionOwner(context, overrides);
        const old = await startWorkspaceAction(owner, phase);
        assert.equal(owner.controller.busy(), true);
        const oldWorkerId = old.request.params.workerId;
        assert.equal(oldWorkerId, 'worker_a');

        if (dismissal === 'dispose') {
          owner.dispose();
        } else {
          if (dismissal === 'cancel') {
            owner.controller.setModal('');
            owner.controller.setModal('project');
          } else if (dismissal === 'A-to-B-to-A') {
            owner.navigate('worker_b', 2);
            owner.navigate('worker_a', 3);
          } else {
            owner.controller.setModal('project');
          }
        }
        assert.equal(owner.controller.busy(), false, 'the abandoned busy owner must be released');

        let replacement;
        if (dismissal !== 'dispose') {
          owner.controller.setModal('import');
          owner.controller.setHandoff('Newer handoff draft');
          replacement = owner.controller.action('worker.pause');
        }
        const modal = owner.controller.modal();
        const draft = owner.controller.handoff();
        const navigation = owner.controller.navigation();
        const requestCount = owner.reads.length;
        owner.notices.length = 0;
        if (outcome === 'failure') {
          old.request.reject(new Error('Obsolete acknowledgement failed.'));
        } else if (phase === 'pending chat') {
          old.request.resolve({ kind: 'chat', result: { resumed: false } });
        } else if (phase === 'pending local') {
          old.request.resolve({ kind: 'local', result: { started: true } });
        } else if (phase === 'chat resume' || phase === 'fresh') {
          old.request.resolve({ resumed: false });
        } else if (phase === 'resend') {
          old.request.resolve({ sent: true });
        } else if (phase === 'import') {
          old.request.resolve({ queued: true });
        } else {
          old.request.resolve({ started: true });
        }
        await flush();
        assert.equal(owner.reads.length, requestCount, 'obsolete completions must not send another mutation');
        await old.completion;
        assert.equal(owner.controller.modal(), modal);
        assert.equal(owner.controller.handoff(), draft);
        assert.equal(owner.controller.navigation(), navigation);
        assert.equal(owner.controller.debugOpen(), false);
        assert.equal(owner.controller.busy(), dismissal !== 'dispose');
        assert.deepEqual(owner.notices, []);

        if (replacement) {
          owner.reads.at(-1).resolve({ paused: true });
          await replacement;
          assert.equal(owner.controller.busy(), false);
        }
      });
    }
  }
}

function clipboardEnvironment(context) {
  const permissions = [];
  const reads = [];
  for (const [name, value] of Object.entries({
    chrome: {
      permissions: {
        request(request) {
          const pending = Promise.withResolvers();
          permissions.push({ request, ...pending });
          return pending.promise;
        },
      },
    },
    navigator: {
      clipboard: {
        readText() {
          const pending = Promise.withResolvers();
          reads.push(pending);
          return pending.promise;
        },
      },
    },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (previous) {
        Object.defineProperty(globalThis, name, previous);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    });
  }
  return { permissions, reads };
}

for (const change of ['edit and restore', 'cancel and reopen', 'replacement', 'dispose', 'A-to-B-to-A']) {
  for (const outcome of ['success', 'failure']) {
    test('clipboard ' + outcome + ' cannot overwrite a newer owner after ' + change, async (context) => {
      const clipboard = clipboardEnvironment(context);
      const owner = await actionOwner(context);
      owner.controller.setModal('import');
      owner.controller.setHandoff('Original draft');
      const copying = owner.controller.readHandoffClipboard();
      assert.deepEqual(clipboard.permissions[0].request, { permissions: ['clipboardRead'] });
      clipboard.permissions[0].resolve(true);
      await flush();
      assert.equal(clipboard.reads.length, 1);
      if (change === 'edit and restore') {
        owner.controller.setHandoff('Intermediate edit');
        owner.controller.setHandoff('Original draft');
      } else if (change === 'cancel and reopen') {
        owner.controller.setModal('');
        owner.controller.setModal('import');
      } else if (change === 'replacement') {
        owner.controller.setModal('project');
      } else if (change === 'dispose') {
        owner.dispose();
      } else {
        owner.navigate('worker_b', 2);
        owner.navigate('worker_a', 3);
      }
      const modal = owner.controller.modal();
      const draft = owner.controller.handoff();
      owner.notices.length = 0;
      if (outcome === 'failure') {
        clipboard.reads[0].reject(new Error('Obsolete clipboard read failed.'));
      } else {
        clipboard.reads[0].resolve('Old clipboard handoff');
      }
      await copying;
      assert.equal(owner.controller.modal(), modal);
      assert.equal(owner.controller.handoff(), draft);
      assert.deepEqual(owner.notices, []);
    });
  }
}

test('import completion starts only its exact accepted batch and keeps edits made while saving', async (context) => {
  const owner = await actionOwner(context);
  const sending = await startWorkspaceAction(owner, 'import');
  const text = handoffText();
  assert.equal(sending.request.params.text, text);
  owner.controller.setHandoff('Newer draft');
  sending.request.resolve({ queued: true });
  await waitFor(() => owner.reads.at(-1)?.method === 'worker.run', 'the captured accepted batch');
  assert.deepEqual(owner.reads.at(-1).params, {
    workerId: 'worker_a',
    epoch: 0,
    envelopeId: 'batch_a',
    envelopeHash: createHash('sha256').update(text).digest('hex'),
  });
  owner.reads.at(-1).resolve({ started: true });
  await sending.completion;
  assert.equal(owner.controller.modal(), 'import');
  assert.equal(owner.controller.handoff(), 'Newer draft');
  assert.equal(owner.controller.busy(), false);
});

for (const phase of [
  'resend',
  'import',
  'import run',
  'pending chat',
  'pending local',
  'chat resume',
  'fresh',
]) {
  test(phase + ' blocks duplicate submits and never retries a lost acknowledgement', async (context) => {
    let overrides = {};
    if (phase === 'fresh') {
      overrides = { control: control('stopped') };
    }
    const owner = await actionOwner(context, overrides);
    const pending = await startWorkspaceAction(owner, phase);
    const requestCount = owner.reads.length;
    if (phase === 'resend') {
      await owner.controller.resendPending();
    } else if (phase === 'import' || phase === 'import run') {
      await owner.controller.importBatch();
    } else if (phase === 'pending chat' || phase === 'pending local') {
      await owner.controller.continuePending();
    } else {
      await owner.controller.runWithChat();
    }
    assert.equal(owner.reads.length, requestCount);
    pending.request.reject(new Error('Acknowledgement was lost.'));
    await pending.completion;
    await flush();
    assert.equal(owner.reads.length, requestCount);
    assert.equal(owner.controller.busy(), false);
    assert.equal(owner.notices.length, 1);
    assert.match(owner.notices[0].message, /Acknowledgement was lost/);
    if (phase === 'import run') {
      assert.match(owner.notices[0].message, /handoff was accepted/);
      assert.match(owner.notices[0].message, /do not import it again/);
      assert.equal(owner.controller.handoff(), handoffText());
      assert.equal(owner.controller.modal(), 'import');
    }
  });
}

test('current Import & run closes only after the exact start acknowledgement', async (context) => {
  const owner = await actionOwner(context);
  const pending = await startWorkspaceAction(owner, 'import run');
  assert.equal(owner.controller.modal(), 'import');
  assert.equal(owner.controller.handoff(), handoffText());
  assert.equal(owner.controller.busy(), true);
  pending.request.resolve({ started: true });
  await pending.completion;
  assert.equal(owner.controller.modal(), '');
  assert.equal(owner.controller.handoff(), '');
  assert.equal(owner.controller.busy(), false);
  assert.equal(owner.notices.length, 1);
  assert.match(owner.notices[0].message, /Handoff queued/);
});

for (const change of ['new run', 'new epoch', 'new batch']) {
  test('pending continuation result cannot affect a replacement ' + change, async (context) => {
    const owner = await actionOwner(context);
    const pending = await startWorkspaceAction(owner, 'pending chat');
    owner.controller.setSnapshot((snapshot) => ({
      ...snapshot,
      workers: snapshot.workers.map((task) => {
        if (task.id !== 'worker_a') {
          return task;
        }
        if (change === 'new run') {
          return { ...task, runId: 'run_2' };
        }
        if (change === 'new epoch') {
          return { ...task, control: control('stopped') };
        }
        return { ...task, queue: [JSON.parse(handoffText('batch_b'))] };
      }),
    }));
    assert.equal(owner.controller.busy(), false);
    pending.request.resolve({ kind: 'chat', result: { resumed: false } });
    await flush();
    assert.equal(owner.reads.length, 1);
    await pending.completion;
    assert.deepEqual(owner.notices, []);
  });
}

test('same-run snapshots preserve one background-owned saved-chat continuation', async (context) => {
  const owner = await actionOwner(context, { queue: [JSON.parse(handoffText())] });
  const pending = await startWorkspaceAction(owner, 'pending chat');
  owner.controller.setSnapshot((snapshot) => ({
    ...snapshot,
    workers: snapshot.workers.map((task) => ({ ...task, observations: ['Unrelated live update'] })),
  }));
  assert.equal(pending.request.method, 'bridge.continuePending');
  assert.deepEqual(pending.request.params, {
    workerId: 'worker_a',
    expectedRun: { runId: 'run_1', epoch: 0 },
  });
  pending.request.resolve({ kind: 'chat', result: { resumed: false } });
  await pending.completion;
  assert.equal(owner.reads.length, 1);
  assert.equal(owner.controller.busy(), false);
  assert.equal(owner.controller.modal(), '');
  assert.equal(owner.notices.length, 1);
  assert.match(owner.notices[0].message, /local batch is preserved/);
});

test('a denied background continuation never falls back to native resume or checkpoint access', async (context) => {
  const owner = await actionOwner(context, { queue: [JSON.parse(handoffText())] });
  const pending = await startWorkspaceAction(owner, 'pending chat');
  pending.request.reject(new Error('The saved chat belongs to a different task or goal.'));
  await pending.completion;
  assert.equal(owner.reads.length, 1);
  assert.equal(owner.controller.busy(), false);
  assert.match(owner.notices[0].message, /different task/);
});

for (const outcome of [
  { kind: 'local', result: { started: true } },
  { kind: 'chat', result: { resumed: true, status: bridge({ workerId: 'worker_a' }) } },
]) {
  test(
    'a valid pending ' + outcome.kind + ' outcome needs only one local request and cannot replay',
    async (context) => {
      const owner = await actionOwner(context, { queue: [JSON.parse(handoffText())] });
      const pending = await startWorkspaceAction(owner, 'pending local');
      pending.request.resolve(outcome);
      await pending.completion;
      await flush();
      assert.deepEqual(
        owner.reads.map((request) => request.method),
        ['bridge.continuePending'],
      );
      assert.equal(owner.controller.busy(), false);
      assert.equal(owner.controller.debugOpen(), false);
      assert.deepEqual(owner.notices, []);
    },
  );
}

for (const result of [
  undefined,
  null,
  { started: true },
  { kind: 'local' },
  { kind: 'local', result: null },
  { kind: 'local', result: { started: false } },
  { kind: 'local', result: { started: true, queued: true } },
  { kind: 'chat', result: { resumed: 'true' } },
  { kind: 'chat', result: { resumed: true, status: null } },
  { kind: 'local', result: { started: true }, unexpected: true },
]) {
  test(
    'malformed pending outcome ' + JSON.stringify(result) + ' cannot succeed, fall back, or replay',
    async (context) => {
      const owner = await actionOwner(context, { queue: [JSON.parse(handoffText())] });
      const pending = await startWorkspaceAction(owner, 'pending local');
      pending.request.resolve(result);
      await pending.completion;
      await flush();
      assert.deepEqual(
        owner.reads.map((request) => request.method),
        ['bridge.continuePending'],
      );
      assert.equal(owner.controller.busy(), false);
      assert.equal(owner.controller.debugOpen(), true);
      assert.equal(owner.controller.modal(), '');
      assert.equal(owner.notices.length, 1);
      assert.match(owner.notices[0].message, /could not confirm the continuation/);
      assert.doesNotMatch(owner.notices[0].message, /local batch is preserved/);
    },
  );
}

for (const change of ['cancel', 'run and restore', 'prompt changed', 'displayed text changed']) {
  test('resend preflight refuses an unreviewed prompt after ' + change, async (context) => {
    const owner = await actionOwner(context);
    const opening = owner.controller.showResend();
    owner.reads[0].resolve('Exact pending prompt\r\nwith original bytes');
    await opening;
    const sending = owner.controller.resendPending();
    assert.equal(owner.reads[1].method, 'bridge.lastPrompt');
    if (change === 'cancel') {
      owner.controller.setModal('');
      owner.controller.setModal('project');
    } else if (change === 'run and restore') {
      const snapshot = owner.controller.snapshot();
      owner.controller.setSnapshot({
        ...snapshot,
        workers: snapshot.workers.map((task) => ({ ...task, runId: 'replacement_run' })),
      });
      owner.controller.setSnapshot(snapshot);
    } else if (change === 'displayed text changed') {
      owner.controller.setTextValue('A newer prompt now displayed in the same dialog');
    }
    owner.reads[1].resolve('Exact pending prompt\nwith normalized bytes');
    await sending;
    assert.equal(owner.reads.length, 2, 'the reviewed bytes must match exactly before dispatching resend');
    assert.equal(owner.controller.busy(), false);
    if (change === 'prompt changed') {
      assert.equal(owner.controller.modal(), 'resend');
      assert.match(owner.notices[0].message, /pending prompt changed/);
    } else {
      assert.deepEqual(owner.notices, []);
    }
  });
}

test('a stale resend dialog cannot submit after leaving and returning to the same worker', async (context) => {
  const owner = await actionOwner(context);
  const opening = owner.controller.showResend();
  owner.reads[0].resolve('Exact pending prompt');
  await opening;
  owner.navigate('worker_b', 2);
  owner.navigate('worker_a', 3);
  await owner.controller.resendPending();
  assert.equal(owner.reads.length, 1);
  assert.match(owner.notices[0].message, /no longer current/);
});

test('a current failed chat resume opens automation for only its captured worker', async (context) => {
  const owner = await actionOwner(context);
  const pending = await startWorkspaceAction(owner, 'chat resume');
  pending.request.resolve({ resumed: false });
  await pending.completion;
  assert.equal(owner.controller.modal(), 'automation');
  assert.deepEqual(owner.controller.automationTarget(), {
    workerId: 'worker_a',
    expectedRun: { runId: 'run_1', epoch: 0 },
  });
  assert.equal(owner.controller.busy(), false);
});

for (const cancellation of ['cancel', 'dispose']) {
  test('clipboard permission cancellation prevents the subsequent read; ' + cancellation, async (context) => {
    const clipboard = clipboardEnvironment(context);
    const owner = await actionOwner(context);
    owner.controller.setModal('import');
    const copying = owner.controller.readHandoffClipboard();
    assert.equal(clipboard.permissions.length, 1, 'permission must start inside the click stack');
    if (cancellation === 'dispose') {
      owner.dispose();
    } else {
      owner.controller.setModal('');
      owner.controller.setModal('import');
    }
    clipboard.permissions[0].resolve(true);
    await copying;
    assert.equal(clipboard.reads.length, 0);
    assert.equal(owner.controller.handoff(), '');
    assert.deepEqual(owner.notices, []);
  });
}

for (const outcome of ['success', 'failure']) {
  test('only the latest clipboard read can install its text; older ' + outcome, async (context) => {
    const clipboard = clipboardEnvironment(context);
    const owner = await actionOwner(context);
    owner.controller.setModal('import');
    const first = owner.controller.readHandoffClipboard();
    clipboard.permissions[0].resolve(true);
    await flush();
    const second = owner.controller.readHandoffClipboard();
    clipboard.permissions[1].resolve(true);
    await flush();
    clipboard.reads[1].resolve('Newer clipboard draft');
    await second;
    if (outcome === 'failure') {
      clipboard.reads[0].reject(new Error('Old clipboard failed.'));
    } else {
      clipboard.reads[0].resolve('Older clipboard draft');
    }
    await first;
    assert.equal(owner.controller.handoff(), 'Newer clipboard draft');
    assert.deepEqual(owner.notices, []);
  });
}

test('clipboard permission denial keeps the draft and offers manual paste without another read', async (context) => {
  const clipboard = clipboardEnvironment(context);
  const owner = await actionOwner(context);
  owner.controller.setModal('import');
  owner.controller.setHandoff('Preserved draft');
  const copying = owner.controller.readHandoffClipboard();
  clipboard.permissions[0].resolve(false);
  await copying;
  assert.equal(owner.controller.handoff(), 'Preserved draft');
  assert.equal(clipboard.reads.length, 0);
  assert.match(owner.notices[0].message, /Paste into the text box instead/);
});

test('disposed controller entrypoints cannot start requests or permission prompts', async (context) => {
  const clipboard = clipboardEnvironment(context);
  const owner = await actionOwner(context);
  owner.controller.setModal('import');
  owner.controller.setHandoff(handoffText());
  owner.dispose();
  await Promise.all([
    owner.controller.readHandoffClipboard(),
    owner.controller.resendPending(),
    owner.controller.runWithChat(),
    owner.controller.continuePending(),
    owner.controller.importBatch(),
    owner.controller.action('worker.pause'),
  ]);
  assert.deepEqual(clipboard.permissions, []);
  assert.deepEqual(owner.reads, []);
  assert.deepEqual(owner.notices, []);
  assert.equal(owner.controller.busy(), false);
});

test('a newer resend prompt in the same dialog releases old busy without reviving its completion', async (context) => {
  const owner = await actionOwner(context);
  const old = await startWorkspaceAction(owner, 'resend');
  const opening = owner.controller.showResend();
  owner.reads.at(-1).resolve('New exact pending prompt');
  await opening;
  assert.equal(owner.controller.busy(), false);
  const current = owner.controller.resendPending();
  assert.equal(owner.reads.at(-1).method, 'bridge.lastPrompt');
  owner.reads.at(-1).resolve('New exact pending prompt');
  await flush();
  const newRequest = owner.reads.at(-1);
  assert.equal(newRequest.method, 'bridge.resend');
  old.request.resolve({ sent: true });
  await old.completion;
  assert.equal(owner.controller.modal(), 'resend');
  assert.equal(owner.controller.textValue(), 'New exact pending prompt');
  assert.equal(owner.controller.busy(), true);
  assert.deepEqual(owner.notices, []);
  newRequest.resolve({ pending: true, sent: false });
  await current;
  assert.equal(owner.controller.modal(), '');
  assert.equal(owner.controller.busy(), false);
  assert.equal(owner.notices.length, 1);
  assert.match(owner.notices[0].message, /saved prompt will send when ready/);
});

test('cancel during handoff hashing cannot dispatch the captured import', async (context) => {
  const owner = await actionOwner(context);
  const digest = Promise.withResolvers();
  context.mock.method(crypto.subtle, 'digest', () => digest.promise);
  owner.controller.setModal('import');
  owner.controller.setHandoff(handoffText());
  const importing = owner.controller.importBatch();
  owner.controller.setModal('project');
  digest.resolve(new Uint8Array(32).buffer);
  await importing;
  assert.deepEqual(owner.reads, []);
  assert.equal(owner.controller.handoff(), handoffText());
  assert.equal(owner.controller.modal(), 'project');
  assert.equal(owner.controller.busy(), false);
  assert.deepEqual(owner.notices, []);
});

for (const invalidText of ['Not JSON', handoffText().replace('worker_a', 'worker_b')]) {
  test(
    'invalid or retargeted handoff never imports or starts a batch: ' + invalidText.slice(0, 20),
    async (context) => {
      const owner = await actionOwner(context);
      owner.controller.setModal('import');
      owner.controller.setHandoff(invalidText);
      await owner.controller.importBatch();
      assert.deepEqual(owner.reads, []);
      assert.equal(owner.controller.handoff(), invalidText);
      assert.equal(owner.controller.modal(), 'import');
      assert.equal(owner.controller.busy(), false);
      assert.equal(owner.notices.length, 1);
    },
  );
}

test('the existing handoff byte cap rejects oversized UTF-8 before parsing or dispatch', async (context) => {
  const owner = await actionOwner(context);
  const text = 'あ'.repeat(Math.floor(MAX_HANDOFF_BYTES / 3) + 1);
  owner.controller.setModal('import');
  owner.controller.setHandoff(text);
  await owner.controller.importBatch();
  assert.deepEqual(owner.reads, []);
  assert.equal(owner.controller.handoff(), text);
  assert.equal(owner.controller.busy(), false);
  assert.match(owner.notices[0].message, /Handoff is too large\. Split it into smaller batches/);
});

test('resend carries the exact original prompt and original dialog-read boundary', async (context) => {
  const owner = await actionOwner(context, { runId: 'reviewed_run', control: control('active') });
  const text = 'Original prompt\r\nwith exact bytes';
  const opening = owner.controller.showResend();
  owner.reads[0].resolve(text);
  await opening;
  owner.controller.setSnapshot((snapshot) => ({ ...snapshot }));
  const sending = owner.controller.resendPending();
  assert.equal(owner.reads[1].method, 'bridge.lastPrompt');
  owner.reads[1].resolve(text);
  await flush();
  assert.deepEqual(owner.reads[2].params, {
    workerId: 'worker_a',
    expectedRun: { runId: 'reviewed_run', epoch: 1 },
    expectedPrompt: text,
    confirm: true,
  });
  owner.reads[2].resolve({ sent: true });
  await sending;
});

for (const method of ['worker.run', 'worker.resume', 'worker.import', 'worker.approve']) {
  test(method + ' captures the menu target boundary rather than the selected worker', async (context) => {
    const owner = await actionOwner(context);
    owner.controller.setSnapshot((snapshot) => ({
      ...snapshot,
      workers: snapshot.workers.map((task) => {
        if (task.id === 'worker_b') {
          return { ...task, runId: 'menu_run', control: { ...control('active'), epoch: 4 } };
        }
        return task;
      }),
    }));
    const sending = owner.controller.action(method, { workerId: 'worker_b' });
    assert.deepEqual(owner.reads[0].params, {
      workerId: 'worker_b',
      expectedRun: { runId: 'menu_run', epoch: 4 },
    });
    assert.equal(owner.controller.selected(), 'worker_a');
    owner.reads[0].resolve({ started: true });
    await sending;
  });
}

for (const phase of ['import', 'pending local', 'pending chat', 'chat resume']) {
  test(phase + ' supplies the captured run and epoch to its receiver', async (context) => {
    const owner = await actionOwner(context, {
      runId: 'reviewed_run',
      control: { ...control('active'), epoch: 6 },
    });
    const pending = await startWorkspaceAction(owner, phase);
    assert.deepEqual(pending.request.params.expectedRun, { runId: 'reviewed_run', epoch: 6 });
    pending.request.reject(new Error('Acknowledgement unavailable.'));
    await pending.completion;
    assert.equal(owner.controller.busy(), false);
  });
}

test('import-created runs start under delivery authority and the captured lease, not the pre-import run ID', async (context) => {
  const owner = await actionOwner(context, {
    runId: 'old_completed_run',
    control: { ...control('active'), epoch: 7 },
  });
  const pending = await startWorkspaceAction(owner, 'import');
  assert.deepEqual(pending.request.params.expectedRun, { runId: 'old_completed_run', epoch: 7 });
  owner.controller.setSnapshot((snapshot) => ({
    ...snapshot,
    workers: snapshot.workers.map((task) => {
      if (task.id === 'worker_a') {
        return { ...task, runId: 'accepted_new_run', queue: [JSON.parse(handoffText())] };
      }
      return task;
    }),
  }));
  pending.request.resolve({ queued: true });
  await waitFor(() => owner.reads.at(-1)?.method === 'worker.run', 'the exact accepted delivery start');
  assert.deepEqual(owner.reads.at(-1).params, {
    workerId: 'worker_a',
    epoch: 7,
    envelopeId: 'batch_a',
    envelopeHash: createHash('sha256').update(handoffText()).digest('hex'),
  });
  assert.equal('expectedRun' in owner.reads.at(-1).params, false);
  owner.reads.at(-1).resolve({ started: true });
  await pending.completion;
});

for (const target of [undefined, 12, '', 'missing_worker']) {
  test(
    'an invalid explicit task target never falls back to the selected worker: ' + String(target),
    async (context) => {
      const owner = await actionOwner(context);
      await owner.controller.action('worker.run', { workerId: target });
      assert.deepEqual(owner.reads, []);
      assert.equal(owner.controller.busy(), false);
      assert.equal(owner.notices.length, 1);
    },
  );
}

for (const boundary of [
  { runId: 'old_run', epoch: 0 },
  { runId: 'run_1', epoch: 2 },
  { runId: 'run_1', epoch: -1 },
  { runId: 'run_1', epoch: 0.5 },
  { runId: 'run_1', epoch: 0, extra: true },
]) {
  test(
    'a stale or invalid reviewed approval boundary cannot be renewed: ' + JSON.stringify(boundary),
    async (context) => {
      const owner = await actionOwner(context);
      await owner.controller.action('worker.approve', {
        workerId: 'worker_a',
        token: 'approval_1',
        approve: true,
        trustRun: true,
        expectedRun: boundary,
      });
      assert.deepEqual(owner.reads, []);
      assert.equal(owner.controller.busy(), false);
      assert.equal(owner.notices.length, 1);
      assert.match(owner.notices[0].message, /Review|review/);
      assert.doesNotMatch(owner.notices[0].message, /"code"|"path"/);
    },
  );
}

test('reviewed approval keeps its token and trust proof with the expected run', async (context) => {
  const owner = await actionOwner(context);
  const params = {
    workerId: 'worker_a',
    expectedRun: { runId: 'run_1', epoch: 0 },
    token: 'approval_1',
    approve: true,
    trustRun: true,
  };
  const approving = owner.controller.action('worker.approve', params);
  assert.deepEqual(owner.reads[0].params, params);
  owner.reads[0].resolve({ approved: true });
  await approving;
});

for (const outcome of ['success', 'failure']) {
  test(
    'menu-target replacement fences its late ' + outcome + ' without clearing newer busy',
    async (context) => {
      const owner = await actionOwner(context);
      const old = owner.controller.action('worker.run', { workerId: 'worker_b' });
      const request = owner.reads[0];
      const original = owner.controller.snapshot();
      owner.controller.setSnapshot({
        ...original,
        workers: original.workers.map((task) => {
          if (task.id === 'worker_b') {
            return { ...task, runId: 'replacement_run' };
          }
          return task;
        }),
      });
      owner.controller.setSnapshot(original);
      assert.equal(owner.controller.busy(), false);
      const current = owner.controller.action('worker.run', { workerId: 'worker_a' });
      if (outcome === 'failure') {
        request.reject(new Error('Old menu request failed.'));
      } else {
        request.resolve({ started: true });
      }
      await old;
      assert.equal(owner.controller.busy(), true);
      assert.equal(owner.controller.debugOpen(), false);
      assert.deepEqual(owner.notices, []);
      assert.deepEqual(request.params.expectedRun, { runId: 'run_1', epoch: 0 });
      owner.reads[1].resolve({ started: true });
      await current;
      assert.equal(owner.controller.busy(), false);
    },
  );
}

test('captured run boundaries use the shared schema and retain legacy epoch zero without renewing it', () => {
  const task = worker({ runId: 'created_run' });
  const captured = reviewedTaskBoundary(task);
  task.runId = 'replacement_run';
  task.control = { ...control('active'), epoch: 9 };
  assert.deepEqual(captured, { runId: 'created_run', epoch: 0 });
  assert.deepEqual(reviewedTaskBoundary(task), { runId: 'replacement_run', epoch: 9 });
  for (const epoch of [-1, 0.5, Number.NaN]) {
    assert.throws(
      () => reviewedTaskBoundary({ ...task, control: { ...control('active'), epoch } }),
      /run boundary is unavailable/,
    );
  }
});

test('new-task local start uses the boundary returned at creation, not a later replacement', async () => {
  const task = worker({
    id: 'new_worker',
    runId: 'created_run',
    control: { ...control('active'), epoch: 3 },
  });
  const starts = [];
  const owner = createRoot((dispose) => ({
    dispose,
    requests: createWorkerFormRequests({
      ...workerLifecycle,
      create: async () => task,
      start: async (workerId, mode, expectedRun) => {
        starts.push({ workerId, mode, expectedRun });
      },
    }),
  }));
  try {
    await owner.requests.create({ projectId: task.projectId });
    task.runId = 'later_run';
    task.control = { ...control('active'), epoch: 10 };
    await owner.requests.start(task.id, 'local');
    assert.deepEqual(starts, [
      { workerId: 'new_worker', mode: 'local', expectedRun: { runId: 'created_run', epoch: 3 } },
    ]);
    await assert.rejects(owner.requests.start('another_worker', 'local'), /not created by the open dialog/);
    assert.equal(starts.length, 1);
    owner.dispose();
    await assert.rejects(owner.requests.start(task.id, 'local'), /not created by the open dialog/);
    assert.equal(starts.length, 1);
  } finally {
    owner.dispose();
  }
});

test('disposed new-task creation cannot supply start authority or invoke a replacement start', async () => {
  const pending = Promise.withResolvers();
  const starts = [];
  const owner = createRoot((dispose) => ({
    dispose,
    requests: createWorkerFormRequests({
      ...workerLifecycle,
      create: () => pending.promise,
      start: async () => starts.push('old'),
    }),
  }));
  const replacement = createRoot((dispose) => ({
    dispose,
    requests: createWorkerFormRequests({
      ...workerLifecycle,
      create: async () => worker({ id: 'replacement_worker' }),
      start: async () => starts.push('replacement'),
    }),
  }));
  try {
    const creating = owner.requests.create({});
    const rejected = assert.rejects(creating, /dialog is closed/);
    owner.dispose();
    await replacement.requests.create({});
    pending.resolve(worker({ id: 'old_worker' }));
    await rejected;
    await assert.rejects(owner.requests.start('old_worker', 'local'), /not created by the open dialog/);
    assert.deepEqual(starts, []);
    await replacement.requests.start('replacement_worker', 'local');
    assert.deepEqual(starts, ['replacement']);
  } finally {
    owner.dispose();
    replacement.dispose();
  }
});

for (const mode of ['handoff', 'local']) {
  test(
    'new-task ' + mode + ' dispatch sends the created run even after a same-epoch replacement',
    async () => {
      const task = worker({
        id: 'new_worker',
        runId: 'created_run',
        control: { ...control('active'), epoch: 3 },
      });
      const calls = [];
      const rpc = async (method, params) => {
        calls.push({ method, params });
        return admittedChat(params.workerId, 'created_start', params.expectedRun);
      };
      const owner = createRoot((dispose) => ({
        dispose,
        requests: createWorkerFormRequests({
          ...workerLifecycle,
          rpc,
          create: async () => task,
          start: (workerId, kind, expectedRun) => startCreatedTask(rpc, workerId, kind, expectedRun),
        }),
      }));
      try {
        await owner.requests.create({ projectId: task.projectId });
        task.runId = 'replacement_run';
        await owner.requests.start(task.id, mode);
        const params = { workerId: task.id, expectedRun: { runId: 'created_run', epoch: 3 } };
        if (mode === 'handoff') {
          assert.deepEqual(calls, [
            {
              method: 'bridge.start',
              params: { ...params, consent: true, newChat: true, maxTurns: 15, maxMinutes: 30 },
            },
          ]);
        } else {
          assert.deepEqual(calls, [{ method: 'worker.run', params }]);
        }
      } finally {
        owner.dispose();
      }
    },
  );
}

const automationOptions = { consent: true, newChat: true, maxTurns: 15, maxMinutes: 30 };

function automationOwner(
  rpc,
  initialTarget = { workerId: 'worker_a', expectedRun: { runId: 'reviewed_run', epoch: 3 } },
) {
  const events = [];
  return createRoot((dispose) => {
    const [target, setTarget] = createSignal(initialTarget);
    const requests = createAutomationFormRequests({
      get workerId() {
        return target().workerId;
      },
      get expectedRun() {
        return target().expectedRun;
      },
      rpc,
      close: () => events.push('closed'),
      started: () => events.push('started'),
    });
    return { dispose, requests, target, setTarget, events };
  });
}

for (const change of ['same epoch new run', 'another worker', 'in-place boundary mutation']) {
  test(
    'automation keeps its original reviewed target through permission wait and ' + change,
    async (context) => {
      const permission = clipboardEnvironment(context);
      const calls = [];
      const owner = automationOwner(async (method, params) => {
        calls.push({ method, params });
        if (method === 'bridge.lastChat') {
          return null;
        }
        return admittedChat(params.workerId, 'reviewed_start', params.expectedRun);
      });
      try {
        const authorizing = owner.requests.authorize();
        assert.equal(permission.permissions.length, 1, 'Chrome permission must start in the click stack');
        assert.deepEqual(permission.permissions[0].request, {
          origins: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
        });
        if (change === 'in-place boundary mutation') {
          owner.target().expectedRun.runId = 'replacement_run';
        } else {
          let workerId = 'worker_a';
          if (change === 'another worker') {
            workerId = 'worker_b';
          }
          owner.setTarget({ workerId, expectedRun: { runId: 'replacement_run', epoch: 3 } });
        }
        permission.permissions[0].resolve(true);
        assert.equal(await authorizing, true);
        await owner.requests.lastChat();
        await owner.requests.start(automationOptions);
        assert.deepEqual(calls, [
          { method: 'bridge.lastChat', params: { workerId: 'worker_a' } },
          {
            method: 'bridge.start',
            params: {
              ...automationOptions,
              workerId: 'worker_a',
              expectedRun: { runId: 'reviewed_run', epoch: 3 },
            },
          },
        ]);
      } finally {
        owner.dispose();
      }
    },
  );
}

for (const dismissal of ['close', 'dispose']) {
  test(
    'automation permission completion cannot submit for a replaced dialog after ' + dismissal,
    async (context) => {
      const permission = clipboardEnvironment(context);
      const calls = [];
      const rpc = async (method, params) => {
        calls.push({ method, params });
        return admittedChat(params.workerId, 'replacement_start', params.expectedRun);
      };
      const owner = automationOwner(rpc);
      let replacement;
      try {
        const authorizing = owner.requests.authorize();
        if (dismissal === 'close') {
          owner.requests.close();
        } else {
          owner.dispose();
        }
        const oldEvents = [...owner.events];
        replacement = automationOwner(rpc, {
          workerId: 'worker_b',
          expectedRun: { runId: 'replacement_run', epoch: 3 },
        });
        permission.permissions[0].resolve(true);
        await authorizing;
        await assert.rejects(owner.requests.start(automationOptions), /task dialog is closed/);
        assert.equal(await owner.requests.authorize(), false);
        assert.equal(permission.permissions.length, 1, 'the dead dialog cannot ask for permission again');
        assert.deepEqual(calls, []);
        owner.requests.started();
        owner.requests.close();
        assert.deepEqual(owner.events, oldEvents);
        assert.deepEqual(replacement.events, []);
        await replacement.requests.start(automationOptions);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].params, {
          ...automationOptions,
          workerId: 'worker_b',
          expectedRun: { runId: 'replacement_run', epoch: 3 },
        });
      } finally {
        owner.dispose();
        replacement?.dispose();
      }
    },
  );
}

for (const outcome of ['success', 'failure']) {
  test(
    'a sent automation start ' + outcome + ' neither replays nor completes a replacement dialog',
    async () => {
      const pending = Promise.withResolvers();
      const calls = [];
      const owner = automationOwner((method, params) => {
        calls.push({ method, params });
        return pending.promise;
      });
      const replacement = automationOwner(async (method, params) => calls.push({ method, params }), {
        workerId: 'worker_b',
        expectedRun: { runId: 'replacement_run', epoch: 3 },
      });
      try {
        const starting = owner.requests.start(automationOptions);
        const settlement = starting.then(
          () => {
            owner.requests.started();
            owner.requests.close();
          },
          () => {},
        );
        owner.dispose();

        if (outcome === 'failure') {
          pending.reject(new Error('Start acknowledgement unavailable.'));
        } else {
          pending.resolve(admittedChat());
        }
        await settlement;
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].params.expectedRun, { runId: 'reviewed_run', epoch: 3 });
        assert.deepEqual(owner.events, []);
        assert.deepEqual(replacement.events, []);
        await assert.rejects(owner.requests.start(automationOptions), /task dialog is closed/);
        assert.equal(calls.length, 1, 'the old mutation is never retried');
      } finally {
        owner.dispose();
        replacement.dispose();
      }
    },
  );
}

test('direct automation opening captures its boundary before later snapshots or navigation', async (context) => {
  const owner = await actionOwner(
    context,
    { state: 'idle', runId: 'reviewed_run', control: { ...control('active'), epoch: 3 } },
    [],
  );
  await owner.controller.runWithChat();
  const target = owner.controller.automationTarget();
  assert.deepEqual(target, { workerId: 'worker_a', expectedRun: { runId: 'reviewed_run', epoch: 3 } });
  owner.controller.setSnapshot((snapshot) => ({
    ...snapshot,
    workers: snapshot.workers.map((task) => ({ ...task, runId: 'replacement_run' })),
  }));
  owner.navigate('worker_b', 2);
  owner.navigate('worker_a', 3);
  assert.equal(owner.controller.automationTarget(), target);
  assert.deepEqual(target.expectedRun, { runId: 'reviewed_run', epoch: 3 });
  assert.deepEqual(owner.reads, []);
});

test('chat resume fallback retains the run boundary captured before the resume read', async (context) => {
  const owner = await actionOwner(context, {
    runId: 'reviewed_run',
    control: { ...control('active'), epoch: 7 },
  });
  const pending = await startWorkspaceAction(owner, 'chat resume');
  assert.equal(owner.controller.automationTarget(), undefined);
  pending.request.resolve({ resumed: false });
  await pending.completion;
  assert.deepEqual(owner.controller.automationTarget(), {
    workerId: 'worker_a',
    expectedRun: { runId: 'reviewed_run', epoch: 7 },
  });
  assert.equal(owner.controller.automationTarget().expectedRun, pending.request.params.expectedRun);
});

for (const change of [
  'same epoch new run',
  'run and restore',
  'dialog replacement',
  'A-to-B-to-A',
  'dispose',
]) {
  test('chat resume fallback cannot open a reviewed automation dialog after ' + change, async (context) => {
    const owner = await actionOwner(context, {
      runId: 'reviewed_run',
      control: { ...control('active'), epoch: 3 },
    });
    const pending = await startWorkspaceAction(owner, 'chat resume');
    if (change === 'dispose') {
      owner.dispose();
    } else if (change === 'dialog replacement') {
      owner.controller.setModal('project');
    } else if (change === 'A-to-B-to-A') {
      owner.navigate('worker_b', 2);
      owner.navigate('worker_a', 3);
    } else {
      const original = owner.controller.snapshot();
      owner.controller.setSnapshot({
        ...original,
        workers: original.workers.map((task) => ({ ...task, runId: 'replacement_run' })),
      });
      if (change === 'run and restore') {
        owner.controller.setSnapshot(original);
      }
    }
    const modal = owner.controller.modal();
    pending.request.resolve({ resumed: false });
    await pending.completion;
    assert.equal(owner.controller.modal(), modal);
    assert.equal(owner.controller.automationTarget(), undefined);
    assert.equal(owner.controller.busy(), false);
    assert.equal(owner.reads.length, 1);
    assert.deepEqual(pending.request.params.expectedRun, { runId: 'reviewed_run', epoch: 3 });
    assert.deepEqual(owner.notices, []);
  });
}

test('required-field ARIA follows native user-invalid state without preemptively flagging pristine inputs', () => {
  const fixture = domFixture();
  const input = fixture.document.createElement('input');
  let userInvalid = false;
  input.matches = (selector) => {
    assert.equal(selector, ':user-invalid');
    return userInvalid;
  };
  syncInputValidity(input);
  assert.equal(input.getAttribute('aria-invalid'), null);
  userInvalid = true;
  syncInputValidity(input);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  userInvalid = false;
  syncInputValidity(input);
  assert.equal(input.getAttribute('aria-invalid'), null);
});
