import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { digest, fixture, importBatch, registerScript, runToBoundary } from './test-fixture.mjs';
import { manualSetupLaunch, prepareManualReport } from '../terminal/manual-setup.ts';
import { STARTER_VITE_VERSION } from './pnpm-setup.ts';

function setup(command) {
  return {
    type: 'setupCommand',
    command,
    purpose: 'Prepare the project for development.',
    effects: 'Creates project files in this folder.',
  };
}

function choice(worker, decision, extra = {}) {
  return {
    workerId: worker.id,
    token: worker.pending.token,
    expectedRun: { runId: worker.runId, epoch: worker.control?.epoch ?? 0 },
    decision,
    ...extra,
  };
}

test('new legacy Vite gets an automatic manifest repair before the first install approval', async (context) => {
  const { service, worker, root } = await fixture(context);
  const install = setup(['pnpm', 'install']);
  const manifest = (version) => JSON.stringify({ devDependencies: { vite: version } });
  const legacy = manifest('^6.4.6');
  await importBatch(service, worker, [
    { type: 'write', path: 'package.json', content: legacy, expectedHash: 'missing' },
    install,
    { type: 'write', path: 'should-wait.txt', content: 'later', expectedHash: 'missing' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
  assert.equal(worker.pending, undefined);
  assert.match(worker.error, /Setup has not run/);
  assert.ok(worker.error.includes(STARTER_VITE_VERSION));
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), legacy);
  await assert.rejects(readFile(path.join(root, 'pnpm-lock.yaml')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(root, 'should-wait.txt')), { code: 'ENOENT' });

  await importBatch(service, worker, [
    {
      type: 'write',
      path: 'package.json',
      content: manifest(STARTER_VITE_VERSION),
      expectedHash: digest(legacy),
    },
    install,
  ]);
  await runToBoundary(service, worker);
  assert.deepEqual(worker.pending?.action, install);
});

test('setup leaves existing Vite manifests and explicit workspace build policies alone', async (context) => {
  const legacy = JSON.stringify({ dependencies: { vite: '~7.2.0' } });
  const install = setup(['pnpm', 'i']);
  for (const location of ['existing manifest', 'project policy', 'parent policy']) {
    await context.test(location, async (subtest) => {
      const { service, worker, root } = await fixture(subtest);
      const actions = [];
      if (location === 'existing manifest') {
        await writeFile(path.join(root, 'package.json'), legacy);
      } else {
        let policyRoot = root;
        if (location === 'parent policy') {
          policyRoot = path.dirname(root);
        }
        await writeFile(path.join(policyRoot, 'pnpm-workspace.yaml'), 'allowBuilds:\n  esbuild: false\n');
        actions.push({ type: 'write', path: 'package.json', content: legacy, expectedHash: 'missing' });
      }
      await importBatch(service, worker, [...actions, install]);
      await runToBoundary(service, worker);
      assert.deepEqual(worker.pending?.action, install);
      assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), legacy);
    });
  }
});

test('identical setup commands each require an exact one-time decision even inside a trusted batch', async (context) => {
  const { service, worker, project, root } = await fixture(context);
  const initial = await registerScript(service, project, root, 'console.log("ready");');
  await writeFile(
    path.join(root, 'setup.cjs'),
    'require("node:fs").appendFileSync("received.txt", process.argv[2] + "\\n");',
  );
  const arg = 'one argument with spaces & shell symbols';
  const action = setup(['node', 'setup.cjs', arg]);
  await importBatch(service, worker, [{ type: 'command', profileId: initial.id }, action, action]);
  await runToBoundary(service, worker);
  await service.handle('worker.approve', {
    workerId: worker.id,
    token: worker.pending.token,
    approve: true,
    trustRun: true,
  });
  await service.wait(worker.id);
  assert.equal(worker.state, 'awaiting_approval');
  assert.deepEqual(worker.pending.action, action);
  await assert.rejects(readFile(path.join(root, 'received.txt')), { code: 'ENOENT' });
  const first = choice(worker, 'run');
  await assert.rejects(
    service.handle('worker.approve', {
      workerId: worker.id,
      token: first.token,
      approve: true,
      trustRun: true,
    }),
    /setup command dialog/,
  );
  await assert.rejects(
    service.handle('worker.setupDecision', { ...first, expectedRun: { runId: 'retired', epoch: 0 } }),
    /earlier task run/,
  );
  await service.handle('worker.setupDecision', first);
  await service.wait(worker.id);
  assert.equal(worker.state, 'awaiting_approval');
  assert.notEqual(worker.pending.token, first.token);
  assert.equal(await readFile(path.join(root, 'received.txt'), 'utf8'), arg + '\n');
  await assert.rejects(service.handle('worker.setupDecision', first), /ended/);
  await service.handle('worker.setupDecision', choice(worker, 'run'));
  await service.wait(worker.id);
  assert.equal(worker.state, 'review');
  assert.equal(await readFile(path.join(root, 'received.txt'), 'utf8'), (arg + '\n').repeat(2));
});

test(
  'a fresh Mac helper can initialize the package manifest in the reviewed task worktree with its bundled pnpm',
  {
    skip: process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch),
  },
  async (context) => {
    const { service, worker, root } = await fixture(context);
    const executionRoot = path.join(path.dirname(root), 'task tree');
    await mkdir(executionRoot);
    worker.worktree = { root: executionRoot, branch: 'test-worktree', baseCommit: 'abc123' };
    await importBatch(service, worker, [setup(['pnpm', 'init'])]);
    await runToBoundary(service, worker);
    await assert.rejects(readFile(path.join(executionRoot, 'package.json')), { code: 'ENOENT' });
    await service.handle('worker.setupDecision', choice(worker, 'run'));
    await service.wait(worker.id);
    const report = await service.handle('worker.report', { workerId: worker.id });
    assert.match(report, /"code":0/);
    assert.equal(
      typeof JSON.parse(await readFile(path.join(executionRoot, 'package.json'), 'utf8')).name,
      'string',
    );
    await assert.rejects(readFile(path.join(root, 'package.json')), { code: 'ENOENT' });
  },
);

test('decline and redirection send user feedback and retire dependent actions without executing them', async (context) => {
  const { service, worker, root } = await fixture(context);
  for (const decision of ['deny', 'instead']) {
    await importBatch(service, worker, [
      setup(['node', '--version']),
      { type: 'write', path: 'stale.txt', expectedHash: 'missing', content: 'should not run' },
    ]);
    await runToBoundary(service, worker);
    const extra = {};
    if (decision === 'instead') {
      extra.instruction = 'Use the existing Python environment.';
    }
    const input = choice(worker, decision, extra);
    await service.handle('worker.setupDecision', input);
    assert.equal(worker.state, 'review');
    assert.equal(worker.pending, undefined);
    assert.equal(worker.queue.length, 0);
    assert.match(
      await service.handle('worker.report', { workerId: worker.id }),
      new RegExp('"decision":"' + decision + '"'),
    );
    await assert.rejects(service.handle('worker.setupDecision', input), /ended/);
  }
  assert.match(
    await service.handle('worker.report', { workerId: worker.id }),
    /Use the existing Python environment/,
  );
  await assert.rejects(readFile(path.join(root, 'stale.txt')), { code: 'ENOENT' });
});

test('manual setup waits for its terminal, returns only its result, and never launches the model command', async (context) => {
  const { service, worker, store, root } = await fixture(context);
  await importBatch(service, worker, [setup(['node', 'missing.cjs'])]);
  await runToBoundary(service, worker);
  let options;
  service.startManualSetup = async (input) => {
    options = input;
    return 'manual-session_1';
  };
  const input = choice(worker, 'manual');
  assert.deepEqual(await service.handle('worker.setupDecision', input), {
    accepted: true,
    sessionId: 'manual-session_1',
  });
  assert.equal(options.root, root);
  assert.equal(options.workerId, worker.id);
  assert.equal(worker.pending.token, input.token);
  assert.equal(worker.pending.manualSessionId, 'manual-session_1');
  assert.equal(worker.state, 'awaiting_approval');
  assert.deepEqual(await service.handle('worker.setupDecision', input), {
    accepted: true,
    sessionId: 'manual-session_1',
  });
  await assert.rejects(service.handle('worker.setupDecision', { ...input, decision: 'run' }), /Pause/);
  options.onFinish('manual-session_1', { code: 3, output: 'Module missing. API_KEY=very-private-value' });
  await service.wait(worker.id);
  const report = await service.handle('worker.report', { workerId: worker.id });
  assert.match(report, /"decision":"manual","exitCode":3/);
  assert.match(report, /Module missing/);
  assert.doesNotMatch(report, /very-private-value|Could not start the registered program/);
  assert.equal(worker.state, 'review');
  assert.equal(worker.pending, undefined);
  assert.equal(store.get('miter.qualityCommands.' + worker.runId), true);
});

test('an interrupted manual terminal cannot publish late results or replay its proposed command', async (context) => {
  const { service, worker, root } = await fixture(context);
  await writeFile(path.join(root, 'script.cjs'), 'require("node:fs").writeFileSync("forbidden.txt","ran");');
  await importBatch(service, worker, [setup(['node', 'script.cjs'])]);
  await runToBoundary(service, worker);
  let options;
  service.startManualSetup = async (input) => {
    options = input;
    return 'manual-session_2';
  };
  await service.handle('worker.setupDecision', choice(worker, 'manual'));
  await service.handle('worker.pause', { workerId: worker.id });
  assert.equal(options.signal.aborted, true);
  await assert.rejects(service.handle('worker.run', { workerId: worker.id }), /Pause the worker/);
  options.onFinish('manual-session_2', { code: 0, output: 'late result' });
  await service.wait(worker.id);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
  const report = await service.handle('worker.report', { workerId: worker.id });
  assert.match(report, /manual setup session was interrupted/i);
  assert.doesNotMatch(report, /late result/);
  await assert.rejects(readFile(path.join(root, 'forbidden.txt')), { code: 'ENOENT' });
});

test('changing the project revision issues a fresh setup request and invalidates the displayed token', async (context) => {
  const { service, worker, project, root } = await fixture(context);
  await importBatch(service, worker, [setup(['node', '--version'])]);
  await runToBoundary(service, worker);
  const prior = choice(worker, 'run');
  await registerScript(service, project, root, 'console.log("changed");');
  await assert.rejects(service.handle('worker.setupDecision', prior), /project changed/i);
  assert.notEqual(worker.pending.token, prior.token);
  assert.equal(worker.pending.revision, project.revision);
  await service.handle('worker.setupDecision', choice(worker, 'deny'));
  assert.equal(worker.state, 'review');
});

test('Run resumes the original active-time budget, excluding time spent in the setup dialog', async (context) => {
  const { service, worker } = await fixture(context);
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  worker.maxMinutes = 1;
  await importBatch(service, worker, [setup(['node', '--version'])]);
  await runToBoundary(service, worker);
  const startedAt = worker.startedAt;
  assert.equal(service.snapshot().workers[0].setupWaitMs, 0);
  now += 360_000;
  assert.equal(service.snapshot().workers[0].setupWaitMs, 360_000);
  await service.handle('worker.setupDecision', choice(worker, 'run'));
  await service.wait(worker.id);
  assert.equal(worker.state, 'review');
  assert.equal(worker.startedAt, startedAt);
  now += 10_000;
  assert.equal(service.snapshot().workers[0].setupWaitMs, 360_000);
});

test('terminal completion before its opening acknowledgement still publishes exactly one manual result', async (context) => {
  const { service, worker } = await fixture(context);
  await importBatch(service, worker, [setup(['node', '--version'])]);
  await runToBoundary(service, worker);
  service.startManualSetup = async ({ onFinish }) => {
    onFinish('fast', { code: 0, output: 'created' });
    return 'fast';
  };
  await service.handle('worker.setupDecision', choice(worker, 'manual'));
  await service.wait(worker.id);
  const results = worker.observations
    .map((entry) => JSON.parse(entry))
    .filter((entry) => entry.result?.decision === 'manual');
  assert.equal(results.length, 1);
  assert.equal(results[0].result.output, 'created');
  assert.equal(worker.state, 'review');
});

async function installedProject(root) {
  const modules = path.join(root, 'node_modules');
  const library = path.join(modules, '.pnpm', 'library@1.0.0', 'node_modules', 'library');
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, 'package.json'), '{"name":"library","version":"1.0.0"}');
  await symlink(path.relative(modules, library), path.join(modules, 'library'));
  await writeFile(path.join(root, 'package.json'), '{"devDependencies":{"library":"1.0.0"}}');
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
  await writeFile(path.join(modules, '.pnpm', 'lock.yaml'), 'lockfileVersion: 9.0');
  await writeFile(path.join(modules, '.modules.yaml'), 'nodeLinker: isolated');
  return library;
}

async function finishManualInstall(service, worker, result) {
  await importBatch(service, worker, [setup(['pnpm', 'install'])]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'awaiting_approval');
  service.startManualSetup = async ({ onFinish }) => {
    onFinish('install-session', result);
    return 'install-session';
  };
  await service.handle('worker.setupDecision', choice(worker, 'manual'));
  await service.wait(worker.id);
}

const managedPnpm = process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch);
test(
  'terminal installation survives report eviction and skips only the unchanged install in this run',
  { skip: !managedPnpm },
  async (context) => {
    const { service, worker, root, project, store } = await fixture(context);
    const library = await installedProject(root);
    await finishManualInstall(service, worker, { code: 0, output: 'Done', plainPnpmInstall: true });
    worker.observations = [];
    assert.match(
      await service.handle('worker.report', { workerId: worker.id }),
      /verified pnpm install already exited 0/i,
    );
    assert.doesNotMatch(
      service.report({ ...worker, runId: 'different-run' }, project),
      /verified pnpm install/i,
    );
    assert.doesNotMatch(
      service.report(worker, { ...project, root: path.dirname(root) }),
      /verified pnpm install/i,
    );
    await writeFile(path.join(root, 'main.ts'), 'console.log("app")');
    await mkdir(path.join(root, 'node_modules', '.vite-temp'));
    const batch = await importBatch(service, worker, [setup(['pnpm', 'i'])]);
    await runToBoundary(service, worker);
    assert.equal(worker.state, 'review');
    assert.match(worker.observations.join(' '), /Already installed.*No command was run/);
    assert.equal(store.get('command:setup:' + batch.id + '_0'), undefined);

    await writeFile(path.join(library, 'package.json'), '{"name":"changed-in-place"}');
    await importBatch(service, worker, [setup(['pnpm', 'install'])]);
    await runToBoundary(service, worker);
    assert.equal(worker.state, 'awaiting_approval');
  },
);

test(
  'a different terminal command, failed install, changed manifest, lock, config or absent dependency requires approval',
  { skip: !managedPnpm },
  async (context) => {
    for (const kind of [
      'different command',
      'nonzero exit',
      'package.json',
      'pnpm-lock.yaml',
      '.npmrc',
      'package removed',
      'workspace',
      'install flags',
    ]) {
      await context.test(kind, async (subtest) => {
        const { service, worker, root } = await fixture(subtest);
        const library = await installedProject(root);
        const result = { code: 0, output: 'Done' };
        if (kind !== 'different command') {
          result.plainPnpmInstall = true;
        }
        if (kind === 'nonzero exit') {
          result.code = 3;
        }
        await finishManualInstall(service, worker, result);
        if (kind === 'package.json') {
          await writeFile(path.join(root, kind), '{"dependencies":{"library":"2.0.0"}}');
        }
        if (kind === 'pnpm-lock.yaml' || kind === '.npmrc') {
          await writeFile(path.join(root, kind), 'changed');
        }
        if (kind === 'package removed') {
          await rm(library, { recursive: true });
        }
        if (kind === 'workspace') {
          await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: [packages/*]');
        }
        const args = ['pnpm', 'install'];
        if (kind === 'install flags') {
          args.push('--offline');
        }
        await importBatch(service, worker, [setup(args)]);
        await runToBoundary(service, worker);
        assert.equal(worker.state, 'awaiting_approval');
      });
    }
  },
);

test(
  'the one-command terminal attests an exact bundled pnpm install without exposing other typed commands',
  { skip: !managedPnpm },
  async (context) => {
    const { root } = await fixture(context);
    await writeFile(path.join(root, 'package.json'), '{"name":"test-package","private":true}');
    for (const [line, expected] of [
      ['pnpm i', true],
      ['printf "Already installed\\n"', false],
      ['pnpm --version', false],
    ]) {
      const report = await prepareManualReport();
      try {
        const launch = manualSetupLaunch('/bin/sh', report.file, process.env.PATH);
        const child = spawn(launch.program, launch.args, {
          cwd: root,
          env: { ...process.env, PATH: launch.path },
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        const done = new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        child.stdin.end(line + '\n');
        const result = await report.result(await done);
        assert.equal(result.code, 0);
        assert.equal(result.plainPnpmInstall === true, expected);
        assert.ok(!result.output.includes(line));
      } finally {
        await report.close();
      }
    }
  },
);
