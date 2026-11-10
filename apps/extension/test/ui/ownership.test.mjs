import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoot, createSignal } from 'solid-js';
import { profileSchema, projectSchema } from '../../../../packages/protocol/src/index.ts';
import { createApprovalTrust } from '../../src/ui/approval-trust.ts';
import {
  createContextDraft,
  createProfileDraft,
  createNotificationsDraft,
  createRenameDraft,
} from '../../src/ui/dialog-forms.ts';
import { worker, flush } from './fixtures.mjs';

const projectA = projectSchema.parse({
  id: 'project_a',
  name: 'A',
  root: '/a',
  profiles: [],
  revision: 1,
  mission: 'A mission',
  conventions: 'A conventions',
});
const projectB = projectSchema.parse({
  id: 'project_b',
  name: 'B',
  root: '/b',
  profiles: [],
  revision: 1,
  mission: 'B mission',
  conventions: 'B conventions',
});
const profile = profileSchema.parse({
  id: 'test',
  label: 'Tests',
  program: 'node',
  args: ['--test'],
  timeoutMs: 120000,
});
const pendingApproval = {
  token: 'approval_1',
  fingerprint: 'fingerprint_1',
  revision: 1,
  reason: 'Review this command.',
  action: { type: 'command', profileId: 'test' },
};
const batch = {
  protocol: 'mitter/1',
  id: 'batch_1',
  workerId: 'worker_1',
  projectId: 'project_1',
  summary: 'Reviewed batch',
  actions: [{ type: 'command', profileId: 'test' }],
};

test('approval trust follows the reviewed token/run/batch, not unrelated same-token snapshots', () => {
  const owner = createRoot((dispose) => {
    const [task, setTask] = createSignal(worker({ pending: pendingApproval, queue: [batch] }));
    const trust = createApprovalTrust(task);
    return { dispose, task, setTask, trust };
  });

  try {
    owner.trust.setChecked(true);
    assert.equal(owner.trust.checked(), true);
    owner.setTask(
      worker({
        ...owner.task(),
        iteration: 2,
        pending: { ...pendingApproval, reason: 'Updated display text.' },
      }),
    );
    assert.equal(owner.trust.checked(), true);

    owner.setTask(worker({ ...owner.task(), pending: { ...pendingApproval, token: 'approval_2' } }));
    assert.equal(owner.trust.checked(), false);
    owner.trust.setChecked(true);
    owner.setTask(worker({ ...owner.task(), runId: 'new_run' }));
    assert.equal(owner.trust.checked(), false);
    owner.trust.setChecked(true);
    owner.setTask(worker({ ...owner.task(), queue: [{ ...batch, id: 'new_batch' }] }));
    assert.equal(owner.trust.checked(), false);
    owner.trust.setChecked(true);
    const reviewed = owner.task();
    const { pending, ...withoutApproval } = reviewed;
    assert.ok(pending);
    owner.setTask(worker(withoutApproval));
    assert.equal(owner.trust.checked(), false);
    owner.setTask(reviewed);
    assert.equal(owner.trust.checked(), false);
  } finally {
    owner.dispose();
  }
});

for (const form of ['context', 'profile']) {
  for (const removed of [false, true]) {
    test(
      form + ' submit retains project A after external A-to-B navigation; removed target=' + removed,
      async () => {
        const calls = [];
        const notices = [];
        let closes = 0;
        const owner = createRoot((dispose) => {
          const [selected, setSelected] = createSignal(projectA);
          const [projects, setProjects] = createSignal([projectA, projectB]);
          const feedback = {
            close: () => {
              closes++;
            },
            success: () => {},
          };
          let draft;

          if (form === 'context') {
            draft = createContextDraft({
              ...feedback,
              project: selected,
              projects,
              notice: (message) => notices.push(message),
              rpc: async (method, params) => {
                calls.push({ method, params });
                return { mission: params.mission, conventions: params.conventions };
              },
            });
          } else {
            draft = createProfileDraft({
              ...feedback,
              get project() {
                return selected();
              },
              projects,
              save: async (params) => {
                calls.push({ method: 'project.profile', params });
              },
            });
          }

          return { draft, dispose, setSelected, setProjects };
        });

        try {
          owner.setSelected(projectB);

          if (removed) {
            owner.setProjects([projectB]);
          }

          if (form === 'context') {
            assert.equal(owner.draft.mission(), 'A mission');
            owner.draft.setMission('Edited A mission');
            await owner.draft.save();
          } else {
            await owner.draft.save(() => profile);
          }

          if (removed) {
            assert.deepEqual(calls, []);
            assert.equal(closes, 0);

            if (form === 'context') {
              assert.match(notices[0], /project is no longer available/);
            } else {
              assert.match(owner.draft.error(), /project is no longer available/);
            }
          } else {
            assert.equal(calls.length, 1);
            assert.equal(calls[0].params.projectId, 'project_a');
            assert.equal(closes, 1);

            if (form === 'context') {
              assert.equal(calls[0].params.mission, 'Edited A mission');
              assert.equal(calls[0].params.conventions, 'A conventions');
            } else {
              assert.deepEqual(calls[0].params.profile, profile);
            }
          }

          assert.equal(owner.draft.busy(), false);
        } finally {
          owner.dispose();
        }
      },
    );
  }
}

const forms = [
  {
    name: 'context',
    result: { mission: 'A mission', conventions: 'A conventions' },
    create: (feedback, send) =>
      createContextDraft({
        ...feedback,
        project: () => projectA,
        projects: () => [projectA, projectB],
        rpc: send,
      }),
    save: (draft) => draft.save(),
  },
  {
    name: 'profile',
    result: projectA,
    create: (feedback, send) =>
      createProfileDraft({
        ...feedback,
        project: projectA,
        projects: () => [projectA, projectB],
        save: async (request) => {
          await send('project.profile', request);
        },
      }),
    save: (draft) => draft.save(() => profile),
  },
  {
    name: 'notifications',
    result: { enabled: false, sound: false },
    create: (feedback, send) =>
      createNotificationsDraft({
        ...feedback,
        preferences: { enabled: false, sound: false },
        rpc: send,
      }),
    save: (draft) => draft.save(),
  },
  {
    name: 'rename',
    result: projectA,
    create: (feedback, send) =>
      createRenameDraft({
        ...feedback,
        target: { kind: 'project', id: projectA.id, name: projectA.name },
        rpc: send,
      }),
    save: (draft) => draft.save(),
  },
];

for (const form of forms) {
  for (const dismissal of ['cancel', 'dispose']) {
    for (const outcome of ['success', 'failure']) {
      test(
        form.name +
          ': late ' +
          outcome +
          ' after ' +
          dismissal +
          ' cannot close or clear busy for a replacement',
        async () => {
          const calls = [];
          const notices = [];
          const successes = [];
          let modal = form.name;
          const feedback = {
            close: () => {
              modal = '';
            },
            notice: (message) => notices.push(message),
            success: (message) => successes.push(message),
          };
          const oldMutation = Promise.withResolvers();
          const replacementMutation = Promise.withResolvers();
          const old = createRoot((dispose) => ({
            dispose,
            draft: form.create(feedback, (method, params) => {
              calls.push({ method, params });
              return oldMutation.promise;
            }),
          }));
          const oldSave = form.save(old.draft);
          await form.save(old.draft);
          assert.equal(calls.length, 1, 'A pending mutation must not be sent twice.');

          if (dismissal === 'cancel') {
            old.draft.close();
          } else {
            old.dispose();
          }

          assert.equal(old.draft.busy(), false);
          modal = 'replacement';
          const replacement = createRoot((dispose) => ({
            dispose,
            draft: form.create(feedback, (method, params) => {
              calls.push({ method, params });
              return replacementMutation.promise;
            }),
          }));

          try {
            assert.equal(replacement.draft.busy(), false);
            const replacementSave = form.save(replacement.draft);
            assert.equal(replacement.draft.busy(), true);

            if (outcome === 'success') {
              oldMutation.resolve(form.result);
            } else {
              oldMutation.reject(new Error('Old mutation failed.'));
            }

            await oldSave;
            assert.equal(modal, 'replacement');
            assert.equal(replacement.draft.busy(), true);
            assert.deepEqual(notices, []);
            assert.deepEqual(successes, []);

            replacementMutation.resolve(form.result);
            await replacementSave;
            assert.equal(modal, '');
            assert.equal(replacement.draft.busy(), false);
            assert.equal(successes.length, 1);
            assert.equal(calls.length, 2);
          } finally {
            old.dispose();
            replacement.dispose();
          }
        },
      );
    }
  }
}

for (const form of forms.filter((form) => form.name !== 'profile')) {
  for (const acknowledgement of [null, undefined, {}]) {
    test(form.name + ' malformed acknowledgement cannot close, report success, or replay', async () => {
      const calls = [];
      const successes = [];
      const owner = createRoot((dispose) => ({
        dispose,
        draft: form.create(
          {
            close: () => assert.fail('An unconfirmed save must not close its dialog.'),
            success: (message) => successes.push(message),
            notice: () => {},
          },
          async (method, params) => {
            calls.push({ method, params });
            return acknowledgement;
          },
        ),
      }));
      try {
        await form.save(owner.draft);
        await flush();
        assert.equal(owner.draft.busy(), false);
        assert.match(owner.draft.error(), /could not read the response/);
        assert.deepEqual(successes, []);
        assert.equal(calls.length, 1);
      } finally {
        owner.dispose();
      }
    });
  }
}

function permissionFixture(context, request) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: { permissions: { request } },
  });
  context.after(() => {
    if (previous) {
      Object.defineProperty(globalThis, 'chrome', previous);
    } else {
      delete globalThis.chrome;
    }
  });
}

test('malformed notification flags cannot request permission, send, or close', async (context) => {
  permissionFixture(context, async () => assert.fail('Malformed flags must not request permission.'));
  const owner = createRoot((dispose) => ({
    dispose,
    draft: createNotificationsDraft({
      preferences: { enabled: 'true', sound: false },
      close: () => assert.fail('Malformed preferences must not close their dialog.'),
      success: () => assert.fail('Malformed preferences must not report success.'),
      rpc: async () => assert.fail('Malformed preferences must not send a mutation.'),
    }),
  }));
  try {
    await owner.draft.save();
    assert.equal(owner.draft.busy(), false);
    assert.match(owner.draft.error(), /boolean/);
  } finally {
    owner.dispose();
  }
});

test('notification permission begins synchronously and cancellation before its reply prevents the mutation', async (context) => {
  const permission = Promise.withResolvers();
  const calls = [];
  let modal = 'notifications';
  permissionFixture(context, (params) => {
    calls.push({ permission: params });
    return permission.promise;
  });
  const owner = createRoot((dispose) => ({
    dispose,
    draft: createNotificationsDraft({
      preferences: { enabled: true, sound: true },
      close: () => {
        modal = '';
      },
      success: () => assert.fail('A cancelled dialog must not report save success.'),
      notice: () => assert.fail('A cancelled dialog must not report save failure.'),
      rpc: async () => assert.fail('Permission returned after cancellation; no mutation may be sent.'),
    }),
  }));

  try {
    const saving = owner.draft.save();
    assert.deepEqual(calls, [{ permission: { permissions: ['notifications'] } }]);
    owner.draft.close();
    modal = 'replacement';
    permission.resolve(true);
    await saving;
    assert.equal(modal, 'replacement');
    assert.equal(owner.draft.busy(), false);
  } finally {
    owner.dispose();
  }
});

test('notification denial releases local busy state without sending or closing; a later user submit may succeed', async (context) => {
  const notices = [];
  const calls = [];
  let granted = false;
  let closes = 0;
  permissionFixture(context, async () => granted);
  const owner = createRoot((dispose) => ({
    dispose,
    draft: createNotificationsDraft({
      preferences: { enabled: true, sound: false },
      close: () => {
        closes++;
      },
      success: () => {},
      notice: (message) => notices.push(message),
      rpc: async (method, params) => {
        calls.push({ method, params });
        return params;
      },
    }),
  }));

  try {
    await owner.draft.save();
    assert.deepEqual(calls, []);
    assert.match(notices[0], /permission was not granted/);
    assert.equal(closes, 0);
    assert.equal(owner.draft.busy(), false);
    granted = true;
    await owner.draft.save();
    await flush();
    assert.deepEqual(calls, [{ method: 'notifications.set', params: { enabled: true, sound: false } }]);
    assert.equal(closes, 1);
    assert.equal(owner.draft.busy(), false);
  } finally {
    owner.dispose();
  }
});
