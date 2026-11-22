import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TerminalControl } from '../../src/background/terminal-control.ts';
import { APP_VERSION } from '../../../../packages/protocol/src/index.ts';
import { nativeRpcRegistry } from '../../src/schemas/native-rpc.ts';
import { viewRpcRegistry } from '../../src/schemas/view-rpc.ts';
import { deferred, settle } from './chrome-mock.mjs';

function command(kind = 'start') {
  const value = {
    kind,
    requestId: randomUUID(),
    claimToken: randomUUID(),
    workerId: 'worker',
    expectedRun: { runId: 'run', epoch: 7 },
  };

  if (kind === 'start') {
    Object.assign(value, { consent: true, maxTurns: 20, maxMinutes: 60 });
  }

  return value;
}

function startResult(current) {
  return {
    workerId: current.workerId,
    expectedRun: current.expectedRun,
    admissionId: randomUUID(),
    tabId: 7,
    url: 'https://chatgpt.com/',
    active: true,
    phase: 'starting',
    reason: 'Starting task',
    turns: 0,
    maxTurns: 20,
    startedAt: 0,
  };
}

function setup(context, current = command()) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const native = [];
  const dispatched = [];
  const errors = [];
  let blocked = false;
  let claimed = false;
  let ready = async () => {};
  let handleNative = async (method, params) => {
    if (method === 'terminal.complete') {
      return { recorded: true };
    }

    if (params.available && !claimed) {
      claimed = true;
      return { command: current };
    }

    return { command: null };
  };
  let request = async () => {
    if (current.kind === 'stop') {
      return { stopped: true, ready: false, epoch: 8, operationId: current.requestId };
    }
    if (current.kind === 'resume') {
      return { resumed: true, status: startResult(current) };
    }

    return startResult(current);
  };
  const relay = new TerminalControl({
    native: async (method, params) => {
      native.push({ method, params });
      return handleNative(method, params);
    },
    request: async (method, params) => {
      dispatched.push({ method, params });
      return request(method, params);
    },
    blocked: () => blocked,
    ready: () => ready(),
    log: (kind, message) => errors.push({ kind, message }),
  });
  context.after(() => relay.dispose());
  relay.start();

  return {
    relay,
    native,
    dispatched,
    errors,
    block: () => {
      blocked = true;
    },
    ready: (next) => {
      ready = next;
    },
    request: (next) => {
      request = next;
    },
    handleNative: (next) => {
      handleNative = next;
    },
    async tick() {
      context.mock.timers.tick(1000);
      await settle();
    },
  };
}

test('terminal relay claims and starts the exact task through ordinary controller admission', async (context) => {
  const current = command();
  const state = setup(context, current);
  await state.tick();
  assert.deepEqual(state.dispatched, [
    {
      method: 'bridge.start',
      params: {
        workerId: current.workerId,
        expectedRun: current.expectedRun,
        consent: true,
        newChat: true,
        maxTurns: 20,
        maxMinutes: 60,
      },
    },
  ]);
  assert.equal(state.native[0].params.version, APP_VERSION);
  assert.equal(state.native[0].params.available, true);
  await state.tick();
  assert.deepEqual(state.native[1], {
    method: 'terminal.complete',
    params: {
      sessionId: state.native[0].params.sessionId,
      requestId: current.requestId,
      claimToken: current.claimToken,
      ok: true,
    },
  });
});

test('a terminal preview starts the exact local run without opening a chat', async (context) => {
  const current = { ...command(), localPreview: true };
  const state = setup(context, current);
  state.request(async () => ({ started: true }));
  await state.tick();
  assert.deepEqual(state.dispatched, [
    { method: 'worker.run', params: { workerId: current.workerId, expectedRun: current.expectedRun } },
  ]);
  await state.tick();
  assert.equal(state.native[1].method, 'terminal.complete');
  assert.equal(state.native[1].params.ok, true);
});

test('terminal stop preserves the reviewed run and durable stop identifier', async (context) => {
  const current = command('stop');
  const state = setup(context, current);
  await state.tick();
  assert.deepEqual(state.dispatched, [
    {
      method: 'bridge.halt',
      params: {
        id: current.requestId,
        workerId: current.workerId,
        expectedRun: current.expectedRun,
      },
    },
  ]);
  await state.tick();
  assert.equal(state.native[1].params.ok, true);
});

test('terminal resume admits only the saved task and exact reviewed run without new-chat or budget options', async (context) => {
  const current = command('resume');
  const state = setup(context, current);
  await state.tick();
  assert.deepEqual(state.dispatched, [
    {
      method: 'bridge.resume',
      params: { workerId: current.workerId, expectedRun: current.expectedRun },
    },
  ]);
  await state.tick();
  assert.equal(state.native[1].params.ok, true);
});

for (const response of [
  { resumed: false },
  { resumed: true },
  {
    resumed: true,
    status: startResult({ workerId: 'another-worker', expectedRun: { runId: 'run', epoch: 7 } }),
  },
]) {
  test('terminal resume rejects an unverified controller acknowledgement without fallback', async (context) => {
    const state = setup(context, command('resume'));
    state.request(async () => response);
    await state.tick();
    await state.tick();
    assert.equal(state.native[1].params.ok, false);
    assert.match(state.native[1].params.error, /may have resumed; it was not replayed/);
    await state.tick();
    assert.deepEqual(
      state.dispatched.map((entry) => entry.method),
      ['bridge.resume'],
    );
  });
}

test('a lost resume acknowledgement and repeated claim only retry the exact completion receipt', async (context) => {
  const current = command('resume');
  const state = setup(context, current);
  let completions = 0;
  state.handleNative(async (method) => {
    if (method === 'terminal.claim') {
      return { command: current };
    }
    completions++;
    if (completions === 1) {
      throw new Error('Receipt acknowledgement lost');
    }
    return { recorded: true };
  });
  for (let index = 0; index < 5; index++) {
    await state.tick();
  }
  assert.deepEqual(
    state.dispatched.map((entry) => entry.method),
    ['bridge.resume'],
  );
  assert.deepEqual(state.native[1], state.native[2]);
  assert.deepEqual(state.native[2], state.native[4]);
});

for (const boundary of ['disconnect', 'reset', 'dispose']) {
  test(`a terminal resume claim cannot dispatch across ${boundary}`, async (context) => {
    const current = command('resume');
    const state = setup(context, current);
    const held = deferred();
    state.handleNative(() => held.promise);
    await state.tick();
    if (boundary === 'disconnect') {
      state.relay.disconnected();
    } else if (boundary === 'reset') {
      state.block();
    } else {
      state.relay.dispose();
    }
    held.resolve({ command: current });
    await settle();
    assert.deepEqual(state.dispatched, []);
  });
}

test('resume keeps ordinary permission and run admission failures without starting fresh', async (context) => {
  const state = setup(context, command('resume'));
  state.request(async () => {
    throw new Error('The reviewed run changed. No permission was granted.');
  });
  await state.tick();
  await state.tick();
  assert.equal(state.native[1].params.ok, false);
  assert.match(state.native[1].params.error, /reviewed run changed/);
  assert.deepEqual(
    state.dispatched.map((entry) => entry.method),
    ['bridge.resume'],
  );
});

test('malformed terminal commands do not reach the task controller', async (context) => {
  const state = setup(context, { ...command(), consent: false });
  await state.tick();
  assert.deepEqual(state.dispatched, []);
  assert.match(state.errors[0].message, /command was invalid/);
});

test('permission or task admission failures are acknowledged without fallback or replay', async (context) => {
  const state = setup(context);
  state.request(async () => {
    throw new Error('ChatGPT access was not granted. No chat was changed.');
  });
  await state.tick();
  await state.tick();
  assert.equal(state.native[1].params.ok, false);
  assert.match(state.native[1].params.error, /access was not granted/);
  await state.tick();
  assert.equal(state.dispatched.length, 1);
});

test('a disconnect after claim admission fences its late result before any task dispatch', async (context) => {
  const current = command();
  const state = setup(context, current);
  const response = deferred();
  state.handleNative(async (method) => {
    if (method === 'terminal.claim') {
      return response.promise;
    }

    return { recorded: true };
  });
  await state.tick();
  state.relay.disconnected();
  response.resolve({ command: current });
  await settle();
  assert.deepEqual(state.dispatched, []);
  await state.tick();
  assert.equal(state.native[1].params.ok, false);
  assert.match(state.native[1].params.error, /connection changed/);
});

test('a lost completion acknowledgement retries only that receipt', async (context) => {
  const current = command();
  const state = setup(context, current);
  let claimed = false;
  let completions = 0;
  state.handleNative(async (method) => {
    if (method === 'terminal.complete') {
      completions++;

      if (completions === 1) {
        throw new Error('Acknowledgement lost');
      }

      return { recorded: true };
    }

    if (!claimed) {
      claimed = true;
      return { command: current };
    }

    return { command: null };
  });
  await state.tick();
  await state.tick();
  await state.tick();
  assert.equal(state.dispatched.length, 1);
  assert.deepEqual(state.native[1], state.native[2]);
});

test('a repeated claimed command repeats its exact saved receipt without a second dispatch', async (context) => {
  const current = command();
  const state = setup(context, current);
  state.handleNative(async (method) => {
    if (method === 'terminal.complete') {
      return { recorded: true };
    }

    return { command: current };
  });
  await state.tick();
  await state.tick();
  await state.tick();
  await state.tick();
  assert.equal(state.dispatched.length, 1);
  assert.deepEqual(state.native[1], state.native[3]);
});

test('slow dispatch keeps the browser heartbeat active without admitting another command', async (context) => {
  const state = setup(context);
  const response = deferred();
  state.request(() => response.promise);
  await state.tick();
  await state.tick();
  await state.tick();
  assert.deepEqual(
    state.native.map((entry) => entry.params.available),
    [true, false, false],
  );
  assert.equal(state.dispatched.length, 1);
  state.relay.dispose();
  response.resolve({});
  await settle();
  await state.tick();
  assert.equal(state.native.length, 3);
});

test('polls cannot overlap and dispose fences both late claims and future reconnects', async (context) => {
  const current = command();
  const state = setup(context, current);
  const response = deferred();
  state.handleNative(() => response.promise);
  await state.tick();
  await state.tick();
  assert.equal(state.native.length, 1);
  state.relay.dispose();
  response.resolve({ command: current });
  await settle();
  await state.tick();
  assert.deepEqual(state.dispatched, []);
  assert.equal(state.native.length, 1);
});

test('reset readiness and blocked state are checked again after awaiting', async (context) => {
  const state = setup(context);
  const ready = deferred();
  state.ready(() => ready.promise);
  await state.tick();
  state.block();
  ready.resolve();
  await settle();
  assert.deepEqual(state.native, []);
  assert.deepEqual(state.dispatched, []);
});

test('a valid but unrelated controller receipt cannot acknowledge this task start', async (context) => {
  const current = command();
  const state = setup(context, current);
  state.request(async () => ({ ...startResult(current), workerId: 'different-worker' }));
  await state.tick();
  await state.tick();
  assert.equal(state.native[1].params.ok, false);
  assert.match(state.native[1].params.error, /may have started; it was not replayed/);
});

test('terminal control methods are native capabilities and cannot be forwarded by a workspace view', () => {
  assert.ok(nativeRpcRegistry['terminal.claim']);
  assert.ok(nativeRpcRegistry['terminal.complete']);
  assert.equal(viewRpcRegistry['terminal.claim'], undefined);
  assert.equal(viewRpcRegistry['terminal.complete'], undefined);
});

test('a helper build change retires a late claim and its receipt', async (context) => {
  const current = command();
  const state = setup(context, current);
  const pending = deferred();
  state.handleNative(() => pending.promise);
  await state.tick();
  const previousId = state.native[0].params.sessionId;
  state.relay.incompatible();
  pending.resolve({ command: current });
  await settle();
  state.handleNative(async () => ({ command: null }));
  await state.tick();
  assert.deepEqual(
    state.native.map(({ method }) => method),
    ['terminal.claim', 'terminal.claim'],
  );
  assert.notEqual(previousId, state.native[1].params.sessionId);
  assert.equal(state.dispatched.length, 0);
});
