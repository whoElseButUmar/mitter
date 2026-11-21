import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalManager } from '../src/core/terminal.js';
import { adaptPtyFactory } from '../src/core/terminal/pty-adapter.js';
import { temporaryDirectory, projectFixture } from './fixtures.mjs';

function fakePty() {
  const dataListeners = new Set();
  const exitListeners = new Set();

  const native = {
    pid: 123,
    disposals: [],
    disposalFailures: new Set(),
    listenerCounts() {
      return { data: dataListeners.size, exit: exitListeners.size };
    },
    writes: [],
    paused: 0,
    resumed: 0,
    killed: [],
    write(data) {
      this.writes.push(data);
    },
    resize() {},
    pause() {
      this.paused++;
    },
    resume() {
      this.resumed++;
    },
    kill(signal) {
      this.killed.push(signal);

      for (const listener of [...exitListeners]) {
        listener({
          exitCode: 0,
        });
      }
    },
    onData(listener) {
      dataListeners.add(listener);

      return {
        dispose() {
          native.disposals.push('data');

          if (native.disposalFailures.has('data')) {
            throw new Error('data listener disposal failed');
          }
          dataListeners.delete(listener);
        },
      };
    },
    onExit(listener) {
      exitListeners.add(listener);

      return {
        dispose() {
          native.disposals.push('exit');

          if (native.disposalFailures.has('exit')) {
            throw new Error('exit listener disposal failed');
          }
          exitListeners.delete(listener);
        },
      };
    },
    emitData(value) {
      for (const listener of dataListeners) {
        listener(value);
      }
    },
    emitExit(value) {
      for (const listener of exitListeners) {
        listener(value);
      }
    },
  };

  return native;
}

async function createTerminal(manager) {
  return manager.dispatch('terminal.create', {
    clientId: 'view',
    projectId: 'project',
    cols: 80,
    rows: 24,
    confirm: true,
  });
}

function snapshot(root) {
  return {
    protocol: 'mitter/1',
    projects: [projectFixture(root)],
    workers: [],
    events: [],
    settings: {
      coderModelPath: '',
      contextSize: 8192,
      maxTokens: 2048,
      gpu: 'auto',
    },
    runtime: {
      node: process.version,
      workflow: 'test',
      models: 'test',
    },
  };
}
test('PTY boundary checks process methods, receiver, subscriptions and ' + 'native events', () => {
  const native = fakePty();
  const factory = adaptPtyFactory({
    spawn() {
      return native;
    },
  });
  const process = factory.spawn('/shell', [], {});
  process.write('raw human input');
  assert.deepEqual(native.writes, ['raw human input']);
  process.onData((value) => assert.equal(typeof value, 'string'));
  process.onExit((value) => assert.equal(value.exitCode, 0));
  native.emitData('valid');
  assert.throws(() =>
    native.emitData({
      text: 'unchecked',
    }),
  );
  native.emitExit({
    exitCode: 0,
  });
  assert.throws(() =>
    native.emitExit({
      exitCode: 'zero',
    }),
  );
  assert.throws(() =>
    adaptPtyFactory({
      spawn() {
        return {
          pid: '123',
        };
      },
    }).spawn('/shell', [], {}),
  );
  assert.throws(() =>
    adaptPtyFactory({
      spawn: true,
    }),
  );
});
test('terminal requests require confirmation and exclusive client ownership', async (t) => {
  const root = await temporaryDirectory(t);
  const native = fakePty();
  const manager = new TerminalManager(
    () => snapshot(root),
    async () => ({
      spawn(shell, args, options) {
        assert.equal(options.cwd, root);
        assert.equal(options.env.NODE_OPTIONS, undefined);
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);

        return native;
      },
    }),
  );
  t.after(() => manager.close());
  const create = {
    clientId: 'first',
    projectId: 'project',
    cols: 80,
    rows: 24,
    confirm: true,
  };
  await assert.rejects(
    manager.dispatch('terminal.create', {
      ...create,
      confirm: false,
    }),
    /confirmation/,
  );
  await assert.rejects(
    manager.dispatch('terminal.create', {
      ...create,
      workerId: 'foreign',
    }),
    /does not belong/,
  );
  await assert.rejects(
    manager.dispatch('terminal.create', {
      ...create,
      injected: true,
    }),
  );
  const info = await manager.dispatch('terminal.create', create);
  await assert.rejects(
    manager.dispatch('terminal.write', {
      clientId: 'second',
      sessionId: info.id,
      data: 'stolen',
    }),
    /another view/,
  );
  await assert.rejects(
    manager.dispatch('terminal.attach', {
      clientId: 'second',
      sessionId: info.id,
    }),
    /another Miter view/,
  );
  await manager.dispatch('terminal.write', {
    clientId: 'first',
    sessionId: info.id,
    data: 'raw',
  });
  assert.equal(native.writes[0], 'raw');
  await manager.dispatch('terminal.release', {
    clientId: 'first',
    sessionId: info.id,
  });
  await manager.dispatch('terminal.attach', {
    clientId: 'second',
    sessionId: info.id,
  });
  await manager.reset();
  assert.equal(native.killed.includes('SIGKILL'), true);
  await assert.rejects(
    manager.dispatch('terminal.list', {
      clientId: 'second',
    }),
    /closed/,
  );
});
test(
  'terminal output is bounded, Unicode-safe and acknowledgements cannot ' + 'skip undelivered data',
  async (t) => {
    const root = await temporaryDirectory(t);
    const native = fakePty();
    const manager = new TerminalManager(
      () => snapshot(root),
      async () => ({
        spawn() {
          return native;
        },
      }),
    );
    t.after(() => manager.close());
    const info = await manager.dispatch('terminal.create', {
      clientId: 'view',
      projectId: 'project',
      cols: 80,
      rows: 24,
      confirm: true,
    });
    const request = {
      clientId: 'view',
      sessionId: info.id,
      after: 0,
    };
    native.emitData('a'.repeat(8191) + '😀' + 'tail');
    const page = await manager.dispatch('terminal.read', request);
    assert.equal(page.frames[0].data.length, 8191);
    assert.equal(page.frames[1].data, '😀tail');
    await assert.rejects(
      manager.dispatch('terminal.read', {
        ...request,
        after: 9999,
      }),
      /ahead of delivered/,
    );
    native.emitData('x'.repeat(300000));
    assert.equal(native.paused, 1);
    let after = page.frames.at(-1).seq;

    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await manager.dispatch('terminal.read', {
        ...request,
        after,
      });
      const last = result.frames.at(-1);

      if (!last) {
        break;
      }
      after = last.seq;
    }
    assert.equal(native.resumed, 1);
    native.emitData('x'.repeat(1200000));
    assert.equal(native.killed.length > 0, true);
  },
);

test('failed terminal event setup disposes its partial subscription and terminates the shell', async (t) => {
  const root = await temporaryDirectory(t);
  const native = fakePty();
  native.onExit = () => {
    throw new Error('exit subscription failed');
  };
  const manager = new TerminalManager(
    () => snapshot(root),
    async () => ({ spawn: () => native }),
  );
  t.after(() => manager.close());

  await assert.rejects(
    manager.dispatch('terminal.create', {
      clientId: 'view',
      projectId: 'project',
      cols: 80,
      rows: 24,
      confirm: true,
    }),
    /exit subscription failed/,
  );

  assert.equal(native.killed.length, 1);
  assert.deepEqual(native.listenerCounts(), { data: 0, exit: 0 });
  assert.deepEqual(await manager.dispatch('terminal.list', { clientId: 'view' }), []);
});

test('terminal reset clears its timeout when exit subscription setup fails', async (t) => {
  const root = await temporaryDirectory(t);
  const native = fakePty();
  const manager = new TerminalManager(
    () => snapshot(root),
    async () => ({ spawn: () => native }),
  );
  await manager.dispatch('terminal.create', {
    clientId: 'view',
    projectId: 'project',
    cols: 80,
    rows: 24,
    confirm: true,
  });
  native.onExit = () => {
    throw new Error('reset subscription failed');
  };
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  t.after(() => {
    for (const call of scheduled.mock.calls) {
      clearTimeout(call.result);
    }
    manager.close();
  });

  await assert.rejects(manager.reset(), /reset subscription failed/);

  assert.equal(scheduled.mock.callCount(), 1);
  const timer = scheduled.mock.calls[0].result;
  assert.equal(
    cleared.mock.calls.some((call) => call.arguments[0] === timer),
    true,
  );
});

test(
  'terminal reset rejects rather than hanging when exit listener disposal throws',
  { timeout: 1000 },
  async (t) => {
    const root = await temporaryDirectory(t);
    const native = fakePty();
    const manager = new TerminalManager(
      () => snapshot(root),
      async () => ({ spawn: () => native }),
    );
    let failDisposal = true;
    t.after(() => {
      failDisposal = false;
      manager.close();
    });
    await manager.dispatch('terminal.create', {
      clientId: 'view',
      projectId: 'project',
      cols: 80,
      rows: 24,
      confirm: true,
    });
    const subscribe = native.onExit;
    native.onExit = (listener) => {
      const subscription = subscribe(listener);

      return {
        dispose() {
          subscription.dispose();

          if (failDisposal) {
            throw new Error('exit listener cleanup failed');
          }
        },
      };
    };

    await assert.rejects(manager.reset(), /exit listener cleanup failed/);
    failDisposal = false;
    await manager.reset();
    assert.deepEqual(native.listenerCounts(), { data: 0, exit: 0 });
  },
);

test('terminal output overflow stays bounded without treating a kill request as confirmed exit', async (t) => {
  const root = await temporaryDirectory(t);
  const native = fakePty();
  native.kill = (signal) => native.killed.push(signal);
  const manager = new TerminalManager(
    () => snapshot(root),
    async () => ({ spawn: () => native }),
  );
  t.after(() => manager.close());
  const info = await manager.dispatch('terminal.create', {
    clientId: 'view',
    projectId: 'project',
    cols: 80,
    rows: 24,
    confirm: true,
  });

  native.emitData('x'.repeat(1200000));
  native.emitData('must not be retained after overflow\n');
  const terminals = await manager.dispatch('terminal.list', { clientId: 'view' });
  assert.equal(terminals[0].exited, false);
  assert.equal(native.killed.length, 1);

  const output = await manager.dispatch('terminal.read', {
    clientId: 'view',
    sessionId: info.id,
    after: 0,
  });
  assert.equal(
    output.frames.some((frame) => frame.data.includes('must not be retained')),
    false,
  );
  let after = output.frames.at(-1)?.seq ?? 0;

  for (let attempt = 0; attempt < 10; attempt++) {
    const page = await manager.dispatch('terminal.read', {
      clientId: 'view',
      sessionId: info.id,
      after,
    });
    const last = page.frames.at(-1);

    if (!last) {
      break;
    }
    after = last.seq;
  }
  assert.equal(native.resumed, 0);

  const reset = manager.reset();
  let resetFinished = false;
  const completion = reset.then(() => {
    resetFinished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resetFinished, false);
  native.emitExit({ exitCode: 0 });
  await completion;
  assert.deepEqual(native.listenerCounts(), { data: 0, exit: 0 });
});

test('closing a terminal keeps its process in the reset barrier until exit is confirmed', async (t) => {
  const root = await temporaryDirectory(t);
  const native = fakePty();
  native.kill = (signal) => native.killed.push(signal);
  const manager = new TerminalManager(
    () => snapshot(root),
    async () => ({ spawn: () => native }),
  );
  t.after(() => {
    native.emitExit({ exitCode: 0 });
    manager.close();
  });
  const info = await manager.dispatch('terminal.create', {
    clientId: 'view',
    projectId: 'project',
    cols: 80,
    rows: 24,
    confirm: true,
  });

  await manager.dispatch('terminal.close', { clientId: 'view', sessionId: info.id, confirm: true });
  assert.deepEqual(await manager.dispatch('terminal.list', { clientId: 'view' }), []);
  await assert.rejects(
    manager.dispatch('terminal.write', {
      clientId: 'view',
      sessionId: info.id,
      data: 'must not run',
    }),
    /no longer exists/,
  );

  let resetFinished = false;
  const reset = manager.reset().then(() => {
    resetFinished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(resetFinished, false);
  assert.equal(native.killed.includes('SIGKILL'), true);
  native.emitExit({ exitCode: 0 });
  await reset;
  assert.deepEqual(native.listenerCounts(), { data: 0, exit: 0 });
});

test('failed setup attempts termination even when partial disposal and kill both throw', async (t) => {
  const root = await temporaryDirectory(t);
  const native = fakePty();
  const registerExit = native.onExit;
  const kill = native.kill;
  native.disposalFailures.add('data');
  native.onExit = () => {
    throw new Error('exit registration failed');
  };
  native.kill = (signal) => {
    native.killed.push(signal);
    throw new Error('shell termination failed');
  };
  const manager = new TerminalManager(
    () => snapshot(root),
    async () => ({ spawn: () => native }),
  );
  t.after(async () => {
    native.disposalFailures.clear();
    native.onExit = registerExit;
    native.kill = kill;
    await manager.reset();
  });
  let failure;

  try {
    await createTerminal(manager);
  } catch (error) {
    failure = error;
  }

  assert.equal(native.killed.length, 1);
  assert.ok(failure instanceof AggregateError);
  assert.match(failure.message, /exit registration failed/);
  assert.match(failure.message, /data listener disposal failed/);
  assert.match(failure.message, /shell termination failed/);
  assert.deepEqual(await manager.dispatch('terminal.list', { clientId: 'view' }), []);

  native.onExit = registerExit;
  native.kill = kill;
  await assert.rejects(manager.reset(), /data listener disposal failed/);
  assert.equal(native.listenerCounts().data, 1);
  await assert.rejects(manager.dispatch('terminal.list', { clientId: 'view' }), /closed/);

  native.disposalFailures.clear();
  await manager.reset();
  assert.deepEqual(native.listenerCounts(), { data: 0, exit: 0 });
});

test('close attempts both exited-session disposers and stops a live peer before reporting failures', async (t) => {
  const root = await temporaryDirectory(t);
  const exited = fakePty();
  const live = fakePty();
  const peers = [exited, live];
  const manager = new TerminalManager(
    () => snapshot(root),
    async () => ({ spawn: () => peers.shift() }),
  );
  t.after(async () => {
    exited.disposalFailures.clear();
    exited.emitExit({ exitCode: 0 });
    live.emitExit({ exitCode: 0 });
    await manager.reset();
  });
  await createTerminal(manager);
  await createTerminal(manager);
  exited.emitExit({ exitCode: 0 });
  exited.disposalFailures.add('data');
  exited.disposalFailures.add('exit');
  live.kill = (signal) => live.killed.push(signal);

  assert.throws(
    () => manager.close(),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /data listener disposal failed/);
      assert.match(error.message, /exit listener disposal failed/);
      return true;
    },
  );
  assert.deepEqual(exited.disposals, ['data', 'exit']);
  assert.equal(live.killed.length, 1);
  assert.deepEqual(live.listenerCounts(), { data: 1, exit: 1 });

  live.emitExit({ exitCode: 0 });
  assert.deepEqual(live.listenerCounts(), { data: 0, exit: 0 });
  exited.disposalFailures.clear();
  await manager.reset();
  assert.deepEqual(exited.listenerCounts(), { data: 0, exit: 0 });
});

test('reset waits for a live peer after an exited session has multiple cleanup failures', async (t) => {
  const root = await temporaryDirectory(t);
  const exited = fakePty();
  const live = fakePty();
  const peers = [exited, live];
  const manager = new TerminalManager(
    () => snapshot(root),
    async () => ({ spawn: () => peers.shift() }),
  );
  t.after(async () => {
    exited.disposalFailures.clear();
    exited.emitExit({ exitCode: 0 });
    live.emitExit({ exitCode: 0 });
    await manager.reset();
  });
  await createTerminal(manager);
  await createTerminal(manager);
  exited.emitExit({ exitCode: 0 });
  exited.disposalFailures.add('data');
  exited.disposalFailures.add('exit');
  live.kill = (signal) => live.killed.push(signal);
  let settled = false;
  const result = manager.reset().then(
    () => {
      settled = true;
      return undefined;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.deepEqual(exited.disposals, ['data', 'exit']);
  assert.deepEqual(live.killed, ['SIGKILL']);
  live.emitExit({ exitCode: 0 });
  const failure = await result;
  assert.ok(failure instanceof AggregateError);
  assert.match(failure.message, /data listener disposal failed/);
  assert.match(failure.message, /exit listener disposal failed/);
  assert.deepEqual(live.listenerCounts(), { data: 0, exit: 0 });

  exited.disposalFailures.clear();
  await manager.reset();
  assert.deepEqual(exited.listenerCounts(), { data: 0, exit: 0 });
});

test('close reports a failed kill and keeps the unconfirmed shell in the reset barrier', async (t) => {
  const root = await temporaryDirectory(t);
  const native = fakePty();
  const kill = native.kill;
  const manager = new TerminalManager(
    () => snapshot(root),
    async () => ({ spawn: () => native }),
  );
  t.after(async () => {
    native.kill = kill;
    native.emitExit({ exitCode: 0 });
    await manager.reset();
  });
  const info = await createTerminal(manager);
  native.kill = (signal) => {
    native.killed.push(signal);
    throw new Error('kill request refused');
  };

  await assert.rejects(
    manager.dispatch('terminal.close', {
      clientId: 'view',
      sessionId: info.id,
      confirm: true,
    }),
    /kill request refused/,
  );
  assert.deepEqual(await manager.dispatch('terminal.list', { clientId: 'view' }), []);
  await assert.rejects(manager.reset(), /kill request refused/);
  assert.equal(native.killed.includes('SIGKILL'), true);
  assert.deepEqual(native.listenerCounts(), { data: 1, exit: 1 });
  await assert.rejects(manager.dispatch('terminal.list', { clientId: 'view' }), /closed/);
});

test('reset attempts SIGKILL and clears its timer when exit registration and kill both fail', async (t) => {
  const root = await temporaryDirectory(t);
  const native = fakePty();
  const registerExit = native.onExit;
  const kill = native.kill;
  const manager = new TerminalManager(
    () => snapshot(root),
    async () => ({ spawn: () => native }),
  );
  await createTerminal(manager);
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  native.onExit = () => {
    throw new Error('reset exit registration failed');
  };
  native.kill = (signal) => {
    native.killed.push(signal);
    throw new Error('reset kill failed');
  };
  t.after(async () => {
    native.onExit = registerExit;
    native.kill = kill;
    native.emitExit({ exitCode: 0 });
    await manager.reset();
  });

  await assert.rejects(manager.reset(), (error) => {
    assert.match(error.message, /reset exit registration failed/);
    assert.match(error.message, /reset kill failed/);
    return true;
  });
  assert.deepEqual(native.killed, ['SIGKILL']);
  const timer = scheduled.mock.calls[0].result;
  assert.equal(
    cleared.mock.calls.some((call) => call.arguments[0] === timer),
    true,
  );
  assert.deepEqual(native.listenerCounts(), { data: 1, exit: 1 });
});

test('reset combines late kill and all disposal failures, retaining each failed resource for cleanup', async (t) => {
  const root = await temporaryDirectory(t);
  const native = fakePty();
  const kill = native.kill;
  const manager = new TerminalManager(
    () => snapshot(root),
    async () => ({ spawn: () => native }),
  );
  t.after(async () => {
    native.disposalFailures.clear();
    native.kill = kill;
    native.emitExit({ exitCode: 0 });
    await manager.reset();
  });
  await createTerminal(manager);
  native.disposalFailures.add('data');
  native.disposalFailures.add('exit');
  native.kill = (signal) => {
    native.killed.push(signal);
    native.emitExit({ exitCode: 0 });
    throw new Error('kill completion failed');
  };

  await assert.rejects(manager.reset(), (error) => {
    assert.match(error.message, /kill completion failed/);
    assert.match(error.message, /data listener disposal failed/);
    assert.match(error.message, /exit listener disposal failed/);
    return true;
  });
  assert.deepEqual(native.disposals, ['exit', 'data', 'exit']);
  assert.deepEqual(native.killed, ['SIGKILL']);
  assert.deepEqual(native.listenerCounts(), { data: 1, exit: 2 });
  await assert.rejects(manager.dispatch('terminal.list', { clientId: 'view' }), /closed/);

  native.disposalFailures.clear();
  await manager.reset();
  assert.deepEqual(native.listenerCounts(), { data: 0, exit: 0 });
});

test('asynchronous close cleanup cannot throw out of onExit or forget failed subscriptions', async (t) => {
  const root = await temporaryDirectory(t);
  const native = fakePty();
  const manager = new TerminalManager(
    () => snapshot(root),
    async () => ({ spawn: () => native }),
  );
  t.after(async () => {
    native.disposalFailures.clear();
    native.emitExit({ exitCode: 0 });
    await manager.reset();
  });
  const info = await createTerminal(manager);
  native.kill = (signal) => native.killed.push(signal);
  await manager.dispatch('terminal.close', { clientId: 'view', sessionId: info.id, confirm: true });
  native.disposalFailures.add('data');
  native.disposalFailures.add('exit');

  assert.doesNotThrow(() => native.emitExit({ exitCode: 0 }));
  assert.deepEqual(native.disposals, ['data', 'exit']);
  await assert.rejects(manager.reset(), (error) => {
    assert.match(error.message, /data listener disposal failed/);
    assert.match(error.message, /exit listener disposal failed/);
    return true;
  });

  native.disposalFailures.clear();
  await manager.reset();
  assert.deepEqual(native.listenerCounts(), { data: 0, exit: 0 });
});

test('reset preserves both missing-exit and waiter-disposal failures without fabricating exit', async (t) => {
  const root = await temporaryDirectory(t);
  const native = fakePty();
  const manager = new TerminalManager(
    () => snapshot(root),
    async () => ({ spawn: () => native }),
  );
  t.after(async () => {
    native.disposalFailures.clear();
    native.emitExit({ exitCode: 0 });
    await manager.reset();
  });
  await createTerminal(manager);
  native.kill = (signal) => native.killed.push(signal);
  native.disposalFailures.add('exit');
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  const rejected = assert.rejects(manager.reset(), (error) => {
    assert.match(error.message, /Shell did not confirm exit/);
    assert.match(error.message, /exit listener disposal failed/);
    return true;
  });
  scheduled.mock.calls[0].arguments[0]();
  await rejected;

  assert.deepEqual(native.killed, ['SIGKILL']);
  const timer = scheduled.mock.calls[0].result;
  assert.equal(
    cleared.mock.calls.some((call) => call.arguments[0] === timer),
    true,
  );
  assert.deepEqual(native.listenerCounts(), { data: 1, exit: 2 });
  await assert.rejects(manager.dispatch('terminal.list', { clientId: 'view' }), /closed/);

  native.disposalFailures.clear();
  native.emitExit({ exitCode: 0 });
  await manager.reset();
  assert.deepEqual(native.listenerCounts(), { data: 0, exit: 0 });
});

test('manual setup rejects the wrong worktree and a decision cancelled during PTY loading', async (t) => {
  const root = await temporaryDirectory(t);
  const entry = snapshot(root);
  entry.workers.push({ id: 'worker', projectId: 'project' });
  const started = Promise.withResolvers();
  const loading = Promise.withResolvers();
  let spawns = 0;
  const manager = new TerminalManager(
    () => entry,
    () => {
      started.resolve();
      return loading.promise;
    },
  );
  t.after(() => manager.reset());
  const controller = new AbortController();
  const options = {
    root,
    workerId: 'worker',
    projectId: 'project',
    signal: controller.signal,
    onFinish: assert.fail,
  };
  const attempt = manager.startManualSetup(options);
  await started.promise;
  controller.abort();
  loading.resolve({
    spawn() {
      spawns++;
      return fakePty();
    },
  });
  await assert.rejects(attempt, { name: 'AbortError' });
  await assert.rejects(
    manager.startManualSetup({ ...options, root: root + '/other', signal: new AbortController().signal }),
    /folder changed/,
  );
  assert.equal(spawns, 0);
});

test('a completed setup terminal can yield its slot while live project shells remain available', async (t) => {
  const root = await temporaryDirectory(t);
  const entry = snapshot(root);
  entry.workers.push({ id: 'worker', projectId: 'project' });
  const ptys = [];
  const manager = new TerminalManager(
    () => entry,
    async () => ({
      spawn() {
        const pty = fakePty();
        ptys.push(pty);
        return pty;
      },
    }),
  );
  t.after(() => manager.reset());
  const existing = await createTerminal(manager);
  const options = {
    root,
    workerId: 'worker',
    projectId: 'project',
    signal: new AbortController().signal,
    onFinish() {},
  };
  const first = await manager.startManualSetup(options);
  for (let i = 0; i < 6; i++) {
    await createTerminal(manager);
  }
  await assert.rejects(manager.startManualSetup(options), /maximum 8/);
  ptys[1].emitExit({ exitCode: 0 });
  const replacement = await manager.startManualSetup(options);
  const ids = (await manager.dispatch('terminal.list', { clientId: 'view', projectId: 'project' })).map(
    (row) => row.id,
  );
  assert.equal(ids.length, 8);
  assert.ok(ids.includes(existing.id) && ids.includes(replacement) && !ids.includes(first));
});
