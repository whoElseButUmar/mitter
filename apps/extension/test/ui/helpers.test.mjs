import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { z } from 'zod';
import { errorMessage } from '../../src/schemas/primitives.ts';
import { checkSchema, approvalSchema } from '../../../../packages/protocol/src/index.ts';
import { rewriteRequestSchema } from '../../../../packages/protocol/src/rewrite.ts';
import { enforceExplicitImportPolicy } from '../../build/import-policy.ts';
import { requireElement } from '../../src/ui/dom.ts';
import { callResult } from '../../src/ui/rpc.ts';
import {
  fileListSchema,
  folderPickSchema,
  resendNotice,
  resendResultSchema,
} from '../../src/ui/rpc-results.ts';
import { savedFonts, teamViewSchema } from '../../src/ui/view-data.ts';
import {
  approvalDescription,
  chatStartLabel,
  checkDescription,
  isFreshContinuation,
} from '../../src/ui/task-view.ts';
import { performDraftRewrite } from '../../src/ui/rewrite-draft.ts';
import { terminalSettings, terminalTheme } from '../../src/ui/terminal-settings.ts';
import { tabRowOptions } from '../../src/ui/tab-row-options.ts';
import { taskStatus } from '../../src/ui/task-status.ts';
import {
  DEFAULT_TERMINAL_PREFERENCES,
  BUNDLED_FONT,
  COLOR_KEYS,
  TerminalColorsSchema,
} from '../../../../packages/terminal/src/appearance.ts';
import { worker, bridge, control, flush } from './fixtures.mjs';

const request = (provider) =>
  rewriteRequestSchema.parse({
    provider,
    mode: 'clarity',
    instruction: 'Preserve this draft.',
  });

test('task status gives pending approval priority over stale completion and bridge progress', () => {
  const reason = 'This command can change project files. Review the registered command before approving.';
  const task = worker({
    state: 'complete',
    pending: {
      token: 'approval_1',
      fingerprint: 'fingerprint_1',
      revision: 1,
      reason,
      action: { type: 'command', profileId: 'test' },
    },
  });
  assert.deepEqual(taskStatus(task, bridge({ active: true, phase: 'running' })), {
    heading: 'Approval needed',
    detail: reason,
    tone: 'attention',
    requiresAttention: true,
  });
  assert.equal(taskStatus(worker({ state: 'awaiting_approval' })).requiresAttention, true);
});

test('App ready requires recorded browser and Lighthouse evidence and ignores stale bridge errors', () => {
  const completion = {
    version: 1,
    verification: 'passed',
    checked: 5,
    at: 1,
    summary: 'All done.',
    evidence: {
      source: 'passed',
      domain: 'passed',
      browser: 'passed',
      lighthouse: 'passed',
      detail: 'Checked snapshot only; deployed performance was not checked.',
    },
  };
  const stale = bridge({ phase: 'error', monitoring: true, reason: 'An earlier reply was unreadable.' });
  assert.deepEqual(taskStatus(worker({ state: 'complete', completion }), stale), {
    heading: 'App ready',
    detail: 'Browser checks passed.',
    tone: 'success',
    requiresAttention: false,
  });
  for (const evidence of [
    { ...completion.evidence, browser: 'not-run' },
    { ...completion.evidence, lighthouse: 'not-run' },
    { source: 'passed', domain: 'passed', browser: 'passed', detail: 'No Lighthouse record.' },
  ]) {
    const result = taskStatus(worker({ state: 'complete', completion: { ...completion, evidence } }), stale);
    assert.equal(result.heading, 'Task complete');
    assert.equal(result.tone, 'neutral');
    assert.match(result.detail, /Checks passed|did not run|were not recorded/);
    assert.equal(result.requiresAttention, false);
  }
});

test('unverified completions never infer success from configured checks or the model summary', () => {
  for (const completion of [
    undefined,
    { version: 1, verification: 'not-run', checked: 0, at: 1, summary: 'All checks passed.' },
    { version: 1, verification: 'legacy-accepted', checked: 0, at: 1, summary: 'Perfect app.' },
    { version: 1, verification: 'passed', checked: 1, at: 1, summary: 'Done.' },
  ]) {
    const result = taskStatus(
      worker({ state: 'complete', checks: [{ type: 'exists', path: 'index.html' }], completion }),
      bridge({ active: true, phase: 'running' }),
    );
    assert.equal(result.heading, 'Task complete');
    if (completion?.verification === 'passed') {
      assert.equal(result.detail, 'Checks passed.');
    } else {
      assert.match(result.detail, /not recorded|did not run/);
    }
    assert.equal(result.tone, 'neutral');
  }
});

test('receiving recovery stays working while a stalled watch preserves the complete attention reason', () => {
  const reason =
    'The reply could not be confirmed. Keep the saved prompt; completed actions must not be replayed.';
  for (const receiving of [false, true]) {
    const result = taskStatus(
      worker({ state: 'review' }),
      bridge({
        phase: 'error',
        monitoring: true,
        receiving,
        errorCode: 'SEND_UNCONFIRMED',
        reason,
      }),
    );
    assert.equal(result.detail, reason);
    assert.equal(result.requiresAttention, !receiving);
    if (receiving) {
      assert.equal(result.heading, 'Reading reply');
      assert.equal(result.tone, 'working');
    } else {
      assert.equal(result.heading, 'Needs attention');
      assert.equal(result.tone, 'attention');
    }
  }
});

test('an automatic layout check stays working until user attention is needed', () => {
  const result = taskStatus(
    worker({ state: 'review' }),
    bridge({
      phase: 'waiting_reply',
      monitoring: true,
      errorCode: 'TRANSCRIPT_UNSUPPORTED',
      reason: 'Checking the chat for a complete reply.',
    }),
  );
  assert.equal(result.heading, 'Checking chat reply');
  assert.equal(result.requiresAttention, false);
});

test('active bridge phases stay concise and automatic retries do not demand manual recovery', () => {
  for (const [phase, heading] of [
    ['connecting', 'Connecting to ChatGPT'],
    ['sending', 'Sending request'],
    ['waiting_reply', 'Waiting for ChatGPT'],
    ['running', 'Updating project'],
    ['reconnecting', 'Reconnecting'],
    ['repairing', 'Repairing reply'],
    ['waiting_team', 'Waiting for another task'],
    ['future-phase', 'Working'],
  ]) {
    const result = taskStatus(
      worker({ state: 'review', error: 'Earlier check failed.' }),
      bridge({
        active: true,
        phase,
        errorCode: 'HOST_RECONNECTING',
        reason: 'Detailed transport diagnostic that remains available in Technical details.',
      }),
    );
    assert.equal(result.heading, heading);
    assert.equal(result.tone, 'working');
    assert.equal(result.requiresAttention, false);
    assert.doesNotMatch(result.detail, /transport diagnostic|Earlier check failed/);
  }
  const approval = taskStatus(worker(), bridge({ active: true, phase: 'waiting_approval' }));
  assert.equal(approval.heading, 'Approval needed');
  assert.equal(approval.requiresAttention, true);
});

test('local checking and file contention keep their own status inside bridge execution', () => {
  for (const [state, heading] of [
    ['verifying', 'Checking results'],
    ['waiting_lock', 'Waiting for files'],
    ['executing', 'Updating project'],
  ]) {
    for (const transport of [undefined, bridge({ active: true, phase: 'running' })]) {
      const result = taskStatus(worker({ state }), transport);
      assert.equal(result.heading, heading);
      assert.equal(result.tone, 'working');
    }
  }
});

test('stopped, fresh, and human review boundaries override stale bridge progress', () => {
  const stale = bridge({ active: true, phase: 'running' });
  assert.equal(taskStatus(worker({ control: control('stopped') }), stale).heading, 'Stopped');
  assert.equal(taskStatus(worker({ state: 'cancelled' }), stale).heading, 'Stopped');
  const review = taskStatus(worker({ humanAcceptanceReady: true }), stale);
  assert.equal(review.heading, 'Ready for review');
  assert.equal(review.requiresAttention, true);
  const fresh = taskStatus(worker({ control: control('fresh') }), bridge({ phase: 'error' }));
  assert.equal(fresh.heading, 'Ready to continue');
  assert.equal(fresh.tone, 'neutral');
});

test('halted errors and failed checks retain exact reasons and ignore another task’s bridge', () => {
  const reason = 'Completion checks failed. Review the recorded results and return a fresh repair batch.';
  for (const state of ['blocked', 'review', 'paused']) {
    const task = worker({ state, error: reason });
    const result = taskStatus(task, bridge({ phase: 'stopped' }));
    assert.equal(result.heading, 'Needs attention');
    assert.equal(result.detail, reason);
    assert.equal(result.requiresAttention, true);
  }
  const transportReason = 'Sign in to the open chat, then resume this task.';
  const halted = taskStatus(worker(), bridge({ phase: 'error', reason: transportReason }));
  assert.equal(halted.detail, transportReason);
  assert.equal(halted.requiresAttention, true);
  assert.equal(
    taskStatus(worker(), bridge({ workerId: 'other_worker', active: true, phase: 'running' })).heading,
    'Ready to start',
  );
});

test('RPC reads validate unknown responses before exposing data to views', async () => {
  const calls = [];
  const result = await callResult(
    async (method, params) => {
      calls.push({ method, params });
      return { root: '/project', files: ['src/main.ts'] };
    },
    fileListSchema,
    'worker.browse',
    { workerId: 'worker_1' },
  );
  assert.deepEqual(result, { root: '/project', files: ['src/main.ts'] });
  assert.deepEqual(calls, [{ method: 'worker.browse', params: { workerId: 'worker_1' } }]);
  await assert.rejects(
    callResult(async () => ({ root: '/project', files: [3] }), fileListSchema, 'worker.browse', {
      workerId: 'worker_1',
    }),
  );
  await assert.rejects(
    callResult(async () => ({ cancelled: 'false' }), folderPickSchema, 'project.pickFolder'),
  );
  assert.deepEqual(folderPickSchema.parse({ cancelled: true }), {
    cancelled: true,
  });
  assert.equal(
    resendNotice(
      resendResultSchema.parse({
        sent: false,
        replyFound: true,
        pending: true,
      }),
    ),
    'A reply has arrived. Miter is checking it instead of resending.',
  );
  assert.match(resendNotice({ sent: false, pending: true }), /Send button/);
  assert.match(resendNotice({ sent: true }), /resent/);
});

test('error messages preserve useful explanations without object labels or Error prefixes', () => {
  const explanation = 'The folder is unavailable. Choose a folder that still exists.';

  for (const failure of [new Error(explanation), explanation, { message: explanation }]) {
    assert.equal(errorMessage(failure), explanation);
  }

  assert.equal(errorMessage({ message: '  Permission was not granted.  ' }), 'Permission was not granted.');

  for (const failure of [new Error(''), ' ', undefined, null, {}, { message: 3 }, 42]) {
    assert.equal(
      errorMessage(failure),
      'Miter could not confirm the result. Check the current state before repeating the action.',
    );
  }
});

test('validation feedback identifies the first invalid field without displaying a JSON diagnostic', () => {
  const result = z.object({ name: z.string().min(1, 'Enter a name.') }).safeParse({ name: '' });
  assert.equal(result.success, false);
  assert.equal(errorMessage(result.error), 'name: Enter a name.');
});

test('invalid RPC responses retain diagnostics and explain that the outcome is unconfirmed', async () => {
  const schema = fileListSchema;

  await assert.rejects(
    callResult(async () => ({ root: '/project', files: [42] }), schema, 'worker.browse', {
      workerId: 'worker_1',
    }),
    (error) => {
      assert.match(error.message, /could not read the response to worker.browse.*not retried/);
      assert.ok(error.cause instanceof z.ZodError);
      assert.deepEqual(error.cause.issues[0].path, ['files', 0]);
      return true;
    },
  );

  const timeout = new Error('The action may still finish. Check the saved result first.');
  await assert.rejects(
    callResult(
      async () => {
        throw timeout;
      },
      schema,
      'worker.browse',
      { workerId: 'worker_1' },
    ),
    (error) => error === timeout,
  );
});

test('saved font recovery is bounded and rejects unsafe family names and malformed rows', () => {
  const first = { family: 'MiterFont_a1', name: 'Local.woff2', data: 'AA==' };
  const second = { family: 'MiterFont_b2', name: 'Other.woff2', data: 'AA==' };
  assert.deepEqual(savedFonts([first, second, { ...first, family: 'MiterFont_c3' }]), [first, second]);
  assert.deepEqual(savedFonts([{ ...first, family: '";color:red' }, first]), [first]);
  assert.deepEqual(savedFonts([{ ...first, name: 'a'.repeat(81) }]), []);
  assert.deepEqual(savedFonts({ fonts: [first] }), []);
  assert.deepEqual(savedFonts(null), []);
  assert.deepEqual(savedFonts([{ ...first, data: '<script>' }, second]), [second]);
  assert.deepEqual(savedFonts([{ ...first, data: 'AA=' }]), []);
});

test('team view requires complete canonical messages and peer summaries, including time zero', () => {
  const peer = { id: 'peer', name: 'Teammate', state: 'paused', branch: 'branch_1', held: '' };
  const message = {
    id: 'message',
    projectId: 'project_1',
    from: 'worker_1',
    message: 'Current',
    time: 0,
    kind: 'message',
  };
  const team = { peers: [peer], messages: [message] };
  assert.deepEqual(teamViewSchema.parse(team), team);

  for (const malformed of [
    { ...team, peers: [{ ...peer, state: 'invented' }] },
    { ...team, peers: [{ ...peer, held: null }] },
    { ...team, peers: [{ name: 'Incomplete', state: 'paused', branch: 'main' }] },
    { ...team, messages: [{ text: 'Legacy', createdAt: 10 }] },
    { ...team, messages: [{ message: 'No identity', time: 20 }] },
    { ...team, messages: [{ ...message, time: null }] },
    { ...team, messages: [{ ...message, kind: 'invented' }] },
  ]) {
    assert.equal(teamViewSchema.safeParse(malformed).success, false);
  }
});

test('task descriptions preserve check literals, profile arguments, and fresh-start label priority', () => {
  assert.equal(checkDescription(checkSchema.parse({ type: 'command', profileId: 'test' })), 'Pass: test');
  assert.equal(checkDescription(checkSchema.parse({ type: 'exists', path: 'a.ts' })), 'Exists: a.ts');
  assert.equal(
    checkDescription(checkSchema.parse({ type: 'contains', path: 'a.ts', text: 'literal' })),
    'a.ts contains “literal”',
  );
  const approval = approvalSchema.parse({
    token: 'token_1',
    fingerprint: 'fingerprint_1',
    revision: 1,
    reason: 'Review this command.',
    action: { type: 'command', profileId: 'test' },
    profile: {
      id: 'test',
      label: 'Tests',
      program: '/bin/tool',
      args: ['--literal', 'a b'],
      timeoutMs: 1000,
    },
  });
  assert.equal(approvalDescription(approval), JSON.stringify(['/bin/tool', '--literal', 'a b'], null, 2));
  assert.equal(
    approvalDescription({ ...approval, profile: undefined }),
    JSON.stringify(approval.action, null, 2),
  );
  assert.equal(isFreshContinuation(undefined), false);
  assert.equal(
    chatStartLabel(worker({ control: control('stopped') }), true, true, 'Resume task'),
    'Continue fresh',
  );
  assert.equal(chatStartLabel(worker(), true, true, 'Resume task'), 'Use reply…');
  assert.equal(chatStartLabel(worker(), false, true, 'Resume task'), 'Connecting…');
  assert.equal(chatStartLabel(worker(), false, false, 'Resume task'), 'Resume task');
});

test('terminal appearance always includes the bundled and safe monospace fallbacks', () => {
  const settings = terminalSettings({
    ...DEFAULT_TERMINAL_PREFERENCES,
    fontFamily: 'Local "Font"',
  });
  assert.equal(
    settings.fontFamily,
    JSON.stringify('Local "Font"') +
      ', ' +
      JSON.stringify(BUNDLED_FONT) +
      ', Menlo, Monaco, Consolas, monospace',
  );
  assert.equal(settings.cursorStyle, DEFAULT_TERMINAL_PREFERENCES.cursorStyle);
  assert.equal(settings.fontSize, DEFAULT_TERMINAL_PREFERENCES.fontSize);
});

test('terminal settings omit undefined optional colors instead of overriding xterm defaults', () => {
  const input = { foreground: '#eeeeee', background: '#111111' };

  for (const key of COLOR_KEYS) {
    if (key !== 'foreground' && key !== 'background') {
      input[key] = undefined;
    }
  }

  const colors = TerminalColorsSchema.parse(input);
  const settings = terminalSettings({
    ...DEFAULT_TERMINAL_PREFERENCES,
    themeId: 'custom-exact',
    customThemes: [{ id: 'custom-exact', name: 'Optional defaults', colors, custom: true }],
  });

  assert.deepEqual(settings.theme, { foreground: '#eeeeee', background: '#111111' });
  assert.equal(Object.hasOwn(settings.theme, 'cursor'), false);
  assert.equal(Object.hasOwn(colors, 'cursor'), true);
  assert.deepEqual(colors, input);
});

test('terminal theme adapter preserves every defined schema color without mutating its input', () => {
  const input = Object.fromEntries(COLOR_KEYS.map((key) => [key, '#123456']));
  const colors = TerminalColorsSchema.parse(input);
  const theme = terminalTheme(colors);

  assert.deepEqual(theme, input);
  assert.deepEqual(colors, input);
  assert.notEqual(theme, colors);
});

test('tab row options omit absent properties and preserve falsy values and callback identities', () => {
  const required = {
    kind: 'project',
    items: [],
    selected: '',
    canAdd: true,
    addLabel: 'New project',
    onSelect: () => {},
    onAdd: () => {},
  };
  const absent = {
    addDisabled: undefined,
    onClose: undefined,
    onList: undefined,
    listLabel: undefined,
    menuItems: undefined,
  };
  const omitted = tabRowOptions({ ...required, ...absent });

  assert.deepEqual(omitted, required);

  for (const key of Object.keys(absent)) {
    assert.equal(Object.hasOwn(omitted, key), false);
  }

  const onClose = () => {};
  const onList = () => {};
  const menuItems = () => [];
  const defined = { ...required, addDisabled: false, listLabel: '', onClose, onList, menuItems };
  const preserved = tabRowOptions(defined);

  assert.deepEqual(preserved, defined);
  assert.equal(preserved.items, required.items);
  assert.equal(preserved.onSelect, required.onSelect);
  assert.equal(preserved.onAdd, required.onAdd);
  assert.equal(preserved.onClose, onClose);
  assert.equal(preserved.onList, onList);
  assert.equal(preserved.menuItems, menuItems);
});

test('checked DOM refs fail explicitly rather than asserting absent elements', () => {
  assert.throws(() => requireElement(undefined, 'test root'), /could not mount test root/);
  assert.throws(() => requireElement(null, 'test root'), /could not mount test root/);
});

test('explicit-import build policy clears all resolved injection sources and fails closed', () => {
  const options = {
    disabled: false,
    imports: ['injected'],
    presets: ['solid'],
    dirs: ['src'],
    addons: ['addon'],
  };
  enforceExplicitImportPolicy(options);
  assert.deepEqual(options, {
    disabled: true,
    autoImport: false,
    imports: [],
    presets: [],
    dirs: [],
    addons: [],
  });
  enforceExplicitImportPolicy(false);
  for (const invalid of [undefined, null, true, 'false', []]) {
    assert.throws(() => enforceExplicitImportPolicy(invalid), /explicit imports cannot be verified/);
  }
});

test('rewrite authorization starts synchronously from the gesture, before the first RPC', async () => {
  const authorization = Promise.withResolvers();
  const calls = [];
  const signal = new AbortController().signal;
  const rewriting = performDraftRewrite(request('chatgpt'), signal, {
    authorize: () => {
      calls.push('authorize');
      return authorization.promise;
    },
    rpc: async (method, params) => {
      calls.push({ method, params });
      return { id: 'rewrite_1', state: 'done', text: 'Rewritten draft.', tabId: 1, at: 0 };
    },
  });
  assert.deepEqual(calls, ['authorize']);
  authorization.resolve(true);
  assert.equal(await rewriting, 'Rewritten draft.');
  assert.equal(calls[1].method, 'rewrite.start');
  assert.equal(calls[1].params.consent, true);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('denied rewrite authorization leaves the draft unchanged without starting work', async () => {
  const calls = [];
  await assert.rejects(
    performDraftRewrite(request('chatgpt'), new AbortController().signal, {
      authorize: async () => false,
      rpc: async (method) => calls.push(method),
    }),
    /access was not granted.*draft is unchanged/,
  );
  assert.deepEqual(calls, []);
});

test('local rewrite skips permission and validates the returned result', async () => {
  const signal = new AbortController().signal;
  const dependencies = {
    authorize: async () => assert.fail('Local rewrite must not request browser permissions.'),
    rpc: async () => ({ id: 'rewrite_1', state: 'done', text: 'Local draft.', provider: 'local' }),
  };
  assert.equal(await performDraftRewrite(request('local'), signal, dependencies), 'Local draft.');
  await assert.rejects(
    performDraftRewrite(request('local'), signal, {
      ...dependencies,
      rpc: async () => ({ id: 'rewrite_1', state: 'done', text: 42, provider: 'local' }),
    }),
  );
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('aborting while rewrite.start is pending cancels the returned job and removes listeners', async () => {
  const started = Promise.withResolvers();
  const controller = new AbortController();
  const calls = [];
  const rewriting = performDraftRewrite(request('local'), controller.signal, {
    authorize: async () => true,
    rpc: (method, params) => {
      calls.push({ method, params });
      if (method === 'rewrite.start') {
        return started.promise;
      }
      return Promise.resolve({});
    },
  });
  controller.abort();
  started.resolve({ id: 'rewrite_1', state: 'waiting', tabId: 1, at: 0 });
  await assert.rejects(rewriting, /Rewrite cancelled/);
  assert.deepEqual(
    calls.map((call) => call.method),
    ['rewrite.start', 'rewrite.cancel'],
  );
  assert.deepEqual(calls[1].params, { id: 'rewrite_1' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('rewrite polling abort clears the wait timer, cancels once, and does not read again', async () => {
  const controller = new AbortController();
  const calls = [];
  const rewriting = performDraftRewrite(request('local'), controller.signal, {
    authorize: async () => true,
    rpc: async (method) => {
      calls.push(method);
      return { id: 'rewrite_1', state: 'waiting', tabId: 1, at: 0 };
    },
  });
  await flush();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 2);
  controller.abort();
  await assert.rejects(rewriting, /Rewrite cancelled/);
  assert.deepEqual(calls, ['rewrite.start', 'rewrite.cancel']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('rewrite polls a waiting job and removes its abort listener when it completes', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const calls = [];
  const rewriting = performDraftRewrite(request('local'), controller.signal, {
    authorize: async () => true,
    rpc: async (method) => {
      calls.push(method);
      if (method === 'rewrite.start') {
        return { id: 'rewrite_1', state: 'waiting', tabId: 1, at: 0 };
      }
      return { id: 'rewrite_1', state: 'done', text: 'Finished draft.', tabId: 1, at: 0 };
    },
  });
  await flush();
  context.mock.timers.tick(1200);
  assert.equal(await rewriting, 'Finished draft.');
  assert.deepEqual(calls, ['rewrite.start', 'rewrite.read']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('setup approval spells the same argv for the local terminal', () => {
  const review = { action: { type: 'setupCommand', command: ['pnpm', 'create', 'my board'] } };
  assert.equal(approvalDescription(review, 'Win32'), "& 'pnpm' 'create' 'my board'");
  assert.equal(approvalDescription(review, 'MacIntel'), "pnpm create 'my board'");
});
