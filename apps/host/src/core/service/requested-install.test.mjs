import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { wantsProjectInstall } from './requested-install.ts';
import { fixture, importBatch, makeEnvelope, makeWorker, runToBoundary } from './test-fixture.mjs';

const goal = 'Build a pottery studio app. I’ll run pnpm install in Miter’s project terminal. Test the app.';
const manifest = {
  type: 'write',
  path: 'package.json',
  expectedHash: 'missing',
  content: '{"name":"studio","private":true}',
};
const finish = { type: 'finish', summary: 'Project ready.' };
const proposed = {
  type: 'setupCommand',
  command: ['pnpm', 'install'],
  purpose: 'Install declared packages',
  effects: 'Writes the lockfile and dependencies.',
};

function setupRequest(worker, decision, extra = {}) {
  return {
    workerId: worker.id,
    token: worker.pending.token,
    expectedRun: { runId: worker.runId, epoch: worker.control?.epoch ?? 0 },
    decision,
    ...extra,
  };
}

test('owner phrasing distinguishes a project install from examples, negation and different commands', () => {
  for (const instruction of [
    goal,
    'I’ll run pnpm install. Actually, skip the install. Changed my mind. I’ll run pnpm install.',
    'Don’t run it for me; I’ll run pnpm install.',
    'I’ll run pnpm install. Don’t run it for me.',
    "I'll run pnpm install",
    'Please let me run `pnpm install`.',
    'I will manually type pnpm i from my terminal.',
    'I’ll run pnpm install and you can build the app.',
    'I’ll run pnpm install, then open the app.',
    'I’ll run pnpm install; then you can test it.',
  ]) {
    assert.equal(wantsProjectInstall(instruction), true, instruction);
  }
  for (const instruction of [
    'I will not run pnpm install.',
    'I’ll run pnpm install. Actually, skip the install.',
    'I’ll run pnpm install, but please cancel the installation.',
    'I’ll run pnpm install. I will not run pnpm install.',
    'I already ran pnpm install.',
    'Run the preview.',
    'Add a tooltip saying “I’ll run pnpm install”.',
    'Document: `I’ll run pnpm install`.',
    'The instructions should say "I’ll run pnpm install".',
    'I’ll run pnpm install --offline',
    'I’ll run pnpm install vite',
    'I’ll run pnpm install ./local.tgz',
    'I’ll run pnpm install && pnpm test',
    'I’ll run pnpm install; pnpm test',
    'I’ll run pnpm install | tee log',
  ]) {
    assert.equal(wantsProjectInstall(instruction), false, instruction);
  }
});

test('the original Kiln prompt opens one setup dialog after a write-only model batch, then publishes its terminal result', async (context) => {
  const { service, worker, store, root } = await fixture(context, { workers: [makeWorker({ goal })] });
  const batch = await importBatch(service, worker, [manifest]);
  await runToBoundary(service, worker);
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), manifest.content);
  assert.equal(worker.state, 'awaiting_approval');
  assert.equal(worker.pending.fromTaskRequest, true);
  assert.deepEqual(worker.pending.action.command, ['pnpm', 'install']);
  assert.equal(worker.queue[0].id, batch.id);
  assert.deepEqual(worker.queue[0].actions, [manifest]);
  assert.equal(worker.cursor, 1);
  const token = worker.pending.token;
  await assert.rejects(service.handle('worker.skip', { workerId: worker.id, confirm: true }), /setup dialog/);
  assert.equal(worker.pending.token, token);
  let terminal;
  service.startManualSetup = async (options) => {
    terminal = options;
    return 'owner-terminal';
  };
  const decision = setupRequest(worker, 'manual');
  await service.handle('worker.setupDecision', decision);
  await service.handle('worker.setupDecision', decision);
  assert.equal(terminal.root, root);
  assert.equal(worker.pending.manualSessionId, 'owner-terminal');
  terminal.onFinish('owner-terminal', {
    code: 0,
    plainPnpmInstall: true,
    output: 'Installed required packages.',
  });
  await service.wait(worker.id);
  assert.equal(worker.state, 'review');
  assert.match(
    await service.handle('worker.report', { workerId: worker.id }),
    /"decision":"manual","exitCode":0/,
  );
  await importBatch(service, worker, [finish]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'complete');
  assert.equal(store.events().filter((e) => e.kind === 'approval').length, 1);
});

test('an existing manifest and a finish-only batch wait for a user decision and preserve the model finish', async (context) => {
  const { service, worker, root } = await fixture(context, { workers: [makeWorker({ goal })] });
  await writeFile(path.join(root, 'package.json'), manifest.content);
  const batch = await importBatch(service, worker, [finish]);
  await runToBoundary(service, worker);
  assert.equal(worker.queue[0].id, batch.id);
  assert.equal(worker.cursor, 0);
  assert.deepEqual(worker.queue[0].actions, [finish]);
  assert.equal(worker.pending.fromTaskRequest, true);
  const prior = setupRequest(worker, 'manual');
  await service.handle('worker.pause', { workerId: worker.id });
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'awaiting_approval');
  assert.notEqual(worker.pending.token, prior.token);
  await assert.rejects(service.handle('worker.setupDecision', prior), /ended/);
  await service.handle(
    'worker.setupDecision',
    setupRequest(worker, 'instead', { instruction: 'Use the managed preview instead.' }),
  );
  await importBatch(service, worker, [proposed]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
  assert.match(worker.error, /declined or redirected/);
  await importBatch(service, worker, [finish]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'complete');
});

test('an existing model install proposal keeps its own review identity across one or more batches', async (context) => {
  for (const separate of [false, true]) {
    await context.test(String(separate), async (t) => {
      const { service, worker, store } = await fixture(t, { workers: [makeWorker({ goal })] });
      if (separate) {
        await importBatch(service, worker, [manifest]);
        await importBatch(service, worker, [proposed]);
      } else {
        await importBatch(service, worker, [manifest, proposed]);
      }
      await runToBoundary(service, worker);
      assert.equal(worker.state, 'awaiting_approval');
      assert.equal(worker.pending.fromTaskRequest, undefined);
      assert.deepEqual(worker.pending.action, proposed);
      await service.handle('worker.setupDecision', setupRequest(worker, 'deny'));
      await importBatch(service, worker, [finish]);
      await runToBoundary(service, worker);
      assert.equal(worker.state, 'complete');
      assert.equal(store.events().filter((e) => e.kind === 'approval').length, 1);
    });
  }
});

test('a missing manifest and an unsuccessful or different terminal command cannot satisfy requested setup', async (context) => {
  for (const outcome of [
    { code: 1, plainPnpmInstall: true },
    { code: 0, plainPnpmInstall: false },
  ]) {
    await context.test(JSON.stringify(outcome), async (t) => {
      const { service, worker } = await fixture(t, { workers: [makeWorker({ goal })] });
      await importBatch(service, worker, [finish]);
      await runToBoundary(service, worker);
      assert.equal(worker.state, 'review');
      assert.match(worker.error, /Create the project package.json/);
      await importBatch(service, worker, [manifest]);
      await runToBoundary(service, worker);
      service.startManualSetup = async ({ onFinish }) => {
        onFinish('one-terminal', { ...outcome, output: 'done' });
        return 'one-terminal';
      };
      await service.handle('worker.setupDecision', setupRequest(worker, 'manual'));
      await service.wait(worker.id);
      await importBatch(service, worker, [finish]);
      await runToBoundary(service, worker);
      assert.equal(worker.state, 'review');
      assert.match(worker.error, /no successful project-terminal result/);
    });
  }
});

test('finish followed by a queued install defers completion and preserves that approval', async (context) => {
  const { service, worker, root, store } = await fixture(context, { workers: [makeWorker({ goal })] });
  await writeFile(path.join(root, 'package.json'), manifest.content);
  await importBatch(service, worker, [finish]);
  const setupBatch = await importBatch(service, worker, [proposed]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'awaiting_approval');
  assert.equal(worker.completion, undefined);
  assert.deepEqual(worker.pending.action, proposed);
  assert.equal(worker.pending.fromTaskRequest, undefined);
  assert.equal(worker.queue[0].id, setupBatch.id);
  assert.equal(store.events().filter((e) => e.kind === 'approval').length, 1);
});

test('restoring a consumed model batch reopens its unanswered setup and never replays its edits', async (context) => {
  const saved = makeWorker({ goal, state: 'awaiting_approval', cursor: 1 });
  const batch = makeEnvelope(saved, [manifest]);
  saved.queue = [batch];
  saved.pending = {
    token: 'expired',
    fingerprint: 'previous',
    revision: 0,
    reason: 'Review setup',
    action: proposed,
    fromTaskRequest: true,
  };
  const { service, worker, root } = await fixture(context, { workers: [saved] });
  assert.equal(worker.state, 'paused');
  assert.equal(worker.pending, undefined);
  // Repeating the original write would conflict with this already existing file.
  await writeFile(path.join(root, 'package.json'), manifest.content);
  await runToBoundary(service, worker);
  assert.equal(worker.pending.fromTaskRequest, true);
  assert.notEqual(worker.pending.token, 'expired');
  assert.equal(worker.queue[0].id, batch.id);
  assert.equal(worker.cursor, 1);
});
