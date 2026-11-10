import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Script, createContext } from 'node:vm';
import path from 'node:path';
import { rolldown } from 'rolldown';
import {
  DOM_READER_URL,
  DOM_READER_LATER_USER_TEXT,
  domReaderPlanSchema,
  domReaderObservationSchema,
  domReaderScenarioNameSchema,
  domReaderReadResultSchema,
  domReaderPageObservationSchema,
} from '../../apps/extension/test/browser/dom-reader-contracts.ts';
import {
  installDomReaderDigestGate,
  inspectDomReaderDigestGate,
  releaseDomReaderDigestGate,
} from '../../apps/extension/test/browser/dom-reader-digest.fixture.ts';
import { DomReaderOfflinePage, openDomReaderOfflinePage } from './chrome-dom-reader-offline.mjs';
import {
  assertDomReaderObservation,
  assertDomReaderInvalidatedRead,
  domReaderEvidenceSchema,
  domReaderEvidenceListSchema,
  DOM_READER_EVIDENCE_LIMIT,
  grantDomReaderHostPermission,
} from './chrome-dom-reader.mjs';
import { DOM_READER_HTML, DOM_READER_POLICY, DOM_READER_PAGE_SOURCE } from './chrome-dom-reader-page.mjs';

function waitingObservation() {
  return domReaderObservationSchema.parse({
    scenario: 'mixed-generating',
    operation: 'inspect',
    count: 4,
    userCount: 2,
    lastRole: 'unknown',
    lastUserId: 'reader-user-current',
    userIds: ['reader-user-prior', 'reader-user-current'],
    busy: true,
    complete: false,
    stopped: false,
    ready: true,
    userExact: true,
    receiptMatched: true,
    assistantExact: false,
    assistantCharacters: 0,
    assistantFormat: 'plain',
    assistantIssue: null,
    codeReply: false,
    codeExact: false,
    copyControl: false,
    codeIssue: 'WAITING_CORRELATED_REPLY',
    receiptState: 'waiting_reply',
    receiptMatches: 1,
    responseControls: 0,
    tailBranches: 1,
    unknownTurns: 1,
    unclassifiedTail: true,
    scanLimited: false,
    transcriptUsers: 2,
    transcriptAssistants: 1,
    history: [{ workerId: 'reader_worker', projectId: 'reader_project', count: 2 }],
  });
}

function invalidatedObservation(scenario) {
  const view = {
    ...waitingObservation(),
    scenario,
    busy: false,
    codeReply: true,
    codeExact: true,
    codeIssue: null,
    receiptState: 'unknown_tail',
    receiptMatches: 0,
  };
  if (scenario === 'digest-dom-mutation') {
    view.userExact = false;
    view.receiptMatched = false;
  } else if (scenario === 'digest-duplicate-before-user') {
    view.count = 5;
    view.unknownTurns = 2;
  } else if (scenario === 'digest-earlier-user-receipt') {
    view.history = [{ workerId: 'reader_worker', projectId: 'reader_project', count: 1 }];
  } else if (scenario === 'digest-later-known-user') {
    view.count = 6;
    view.userCount = 3;
    view.transcriptUsers = 3;
    view.unknownTurns = 2;
    view.lastUserId = 'reader-user-later';
    view.userIds.push('reader-user-later');
    view.receiptMatched = false;
    view.receiptMatches = 1;
  }
  return domReaderObservationSchema.parse(view);
}

function interceptorFixture(request = async () => ({})) {
  const output = new PassThrough();
  output.setEncoding('utf8');
  const commands = [];
  let killed = false;
  const chrome = {
    child: { stdio: [undefined, undefined, undefined, undefined, output] },
    kill() {
      killed = true;
    },
    async request(method, params, session) {
      commands.push({ method, params, session });
      return request(method, params, session);
    },
  };
  const target = { targetId: 'reader-target', session: 'reader-session' };
  const offline = new DomReaderOfflinePage(chrome, target, 'reader-frame');
  const emit = (params, sessionId = target.session, method = 'Fetch.requestPaused') => {
    output.write(JSON.stringify({ sessionId, method, params }) + '\0');
  };
  return { offline, output, chrome, commands, emit, killed: () => killed };
}

function pausedRequest(overrides = {}) {
  return {
    requestId: 'request-1',
    frameId: 'reader-frame',
    resourceType: 'Document',
    request: { method: 'GET', url: DOM_READER_URL },
    ...overrides,
  };
}

test('the reader assertion rejects the observed mixed-role baseline and lost history or IDs', () => {
  const waiting = waitingObservation();
  assert.doesNotThrow(() => assertDomReaderObservation(waiting));
  assert.throws(
    () => assertDomReaderObservation({ ...waiting, receiptState: null, receiptMatches: 0 }),
    /do not skip fallback for a mixed-role tail/,
  );
  for (const changed of [
    { count: 2 },
    { userCount: 1, transcriptUsers: 1 },
    { lastUserId: 'receipt-reader_send' },
    { userIds: ['reader-user-current'] },
    { history: [{ workerId: 'reader_worker', projectId: 'reader_project', count: 1 }] },
    { complete: true },
    { unclassifiedTail: false },
  ]) {
    assert.throws(() => assertDomReaderObservation({ ...waiting, ...changed }));
  }
});

test('the correlated Copy code lane still requires receipt-bound waiting and response controls', () => {
  const waiting = {
    ...waitingObservation(),
    scenario: 'mixed-generating-correlated',
    codeReply: true,
    codeExact: true,
    copyControl: true,
  };
  assert.doesNotThrow(() => assertDomReaderObservation(waiting));
  assert.throws(() => assertDomReaderObservation({ ...waiting, receiptState: null }));
  for (const copy of [false, true]) {
    let scenario = 'complete-roleless';
    if (copy) {
      scenario = 'complete-roleless-copy-code';
    }
    const complete = {
      ...waiting,
      scenario,
      lastRole: 'assistant',
      busy: false,
      complete: true,
      assistantExact: true,
      assistantCharacters: 360,
      assistantFormat: 'code',
      receiptState: 'matched',
      responseControls: 2,
      unknownTurns: 0,
      unclassifiedTail: false,
      transcriptAssistants: 2,
      copyControl: copy,
    };
    assert.doesNotThrow(() => assertDomReaderObservation(complete));
    assert.throws(() => assertDomReaderObservation({ ...complete, assistantExact: false }));
    assert.throws(() => assertDomReaderObservation({ ...complete, responseControls: 0 }));
  }
});

test('assistant-only reasoning progress during digest keeps unchanged user waiting proof', () => {
  const view = { ...waitingObservation(), scenario: 'digest-assistant-progress' };
  assert.doesNotThrow(() => assertDomReaderObservation(view));
  assert.throws(
    () => assertDomReaderObservation({ ...view, receiptState: 'unknown_tail', receiptMatches: 0 }),
    /require waiting proof from the full receipt/,
  );
  for (const changed of [
    { receiptMatches: 0 },
    { receiptState: 'matched' },
    { receiptMatched: false },
    { userExact: false },
    { busy: false },
    { complete: true },
    { assistantCharacters: 12 },
    { unclassifiedTail: false },
    { userIds: ['reader-user-prior'] },
    { unknownTurns: 2 },
    { responseControls: 2 },
    { codeReply: true },
  ]) {
    assert.throws(() => assertDomReaderObservation({ ...view, ...changed }));
  }
});

test('held DOM mutations discard proof and refresh current known IDs and distinct history', () => {
  for (const scenario of [
    'digest-dom-mutation',
    'digest-duplicate-before-user',
    'digest-earlier-user-receipt',
    'digest-later-known-user',
  ]) {
    const view = invalidatedObservation(scenario);
    assert.doesNotThrow(() => assertDomReaderInvalidatedRead(view));
    let wrongMatches = 1;
    if (view.receiptMatches === 1) {
      wrongMatches = 0;
    }
    for (const changed of [
      { complete: true },
      { assistantCharacters: 12 },
      { assistantExact: true },
      { receiptMatches: wrongMatches },
      { responseControls: 2 },
      { receiptState: 'waiting_reply' },
      { receiptState: 'matched' },
      { unclassifiedTail: false },
      { count: view.count - 1 },
      { userIds: view.userIds.slice(1) },
      { lastUserId: 'receipt-reader_send' },
      { receiptMatched: !view.receiptMatched },
      { userExact: !view.userExact },
      { history: view.history.map((group) => ({ ...group, count: group.count + 1 })) },
      { history: [] },
    ]) {
      assert.throws(() => assertDomReaderInvalidatedRead({ ...view, ...changed }), scenario);
    }
  }
});

test('fresh duplicate inspection requires two full matches without losing known users or current history', () => {
  for (const scenario of ['digest-duplicate-before-user', 'digest-earlier-user-receipt']) {
    const view = { ...invalidatedObservation(scenario), receiptState: 'ambiguous', receiptMatches: 2 };
    assert.doesNotThrow(() => assertDomReaderObservation(view));
    for (const changed of [
      { receiptState: 'matched' },
      { receiptMatches: 1 },
      { complete: true },
      { assistantCharacters: 12 },
      { unclassifiedTail: false },
      { count: view.count - 1 },
      { userIds: ['reader-user-prior'] },
      { receiptMatched: false },
      { history: view.history.map((group) => ({ ...group, count: group.count + 1 })) },
      { history: [] },
    ]) {
      assert.throws(() => assertDomReaderObservation({ ...view, ...changed }), scenario);
    }
  }
});

test('fresh inspection keeps a later known user barrier instead of reusing the captured current anchor', () => {
  const view = {
    ...invalidatedObservation('digest-later-known-user'),
    receiptMatches: 1,
    codeReply: false,
    codeExact: false,
    codeIssue: 'NEWER_USER_MESSAGE',
  };
  assert.doesNotThrow(() => assertDomReaderObservation(view));
  for (const changed of [
    { lastUserId: 'reader-user-current' },
    { userIds: ['reader-user-prior', 'reader-user-current'] },
    { count: 4 },
    { userCount: 2, transcriptUsers: 2 },
    { receiptMatched: true },
    { receiptMatches: 0 },
    { receiptState: 'matched' },
    { codeReply: true },
    { codeIssue: null },
  ]) {
    assert.throws(() => assertDomReaderObservation({ ...view, ...changed }));
  }
});

test('retained evidence bounds include 25 scenarios, three refresh reads, and three probes', () => {
  assert.equal(domReaderScenarioNameSchema.options.length, 25);
  assert.equal(DOM_READER_EVIDENCE_LIMIT, 31);
  const observation = waitingObservation();
  const item = { scenario: observation.scenario, phase: 'inspection', result: { ok: true, observation } };
  const maximum = Array.from({ length: DOM_READER_EVIDENCE_LIMIT }, () => item);
  assert.equal(domReaderEvidenceListSchema.parse(maximum).length, DOM_READER_EVIDENCE_LIMIT);
  assert.equal(domReaderEvidenceListSchema.safeParse([...maximum, item]).success, false);
  assert.equal(domReaderEvidenceSchema.safeParse({ ...item, phase: 'unbounded' }).success, false);
});

test('the CDP-owned page builder remains a valid script without executing a mocked DOM', () => {
  assert.doesNotThrow(() => new Script(DOM_READER_PAGE_SOURCE));
});

test('retained result schemas reject bodies, raw HTML, malformed counters and ambiguous outcomes', () => {
  const observation = waitingObservation();
  const evidence = {
    scenario: observation.scenario,
    phase: 'inspection',
    result: { ok: true, observation },
  };
  assert.deepEqual(domReaderEvidenceSchema.parse(evidence), evidence);
  for (const value of [
    { ...observation, assistantText: 'Private source must not be logged.' },
    { ...observation, lastUserText: 'Private prompt must not be logged.' },
    { ...observation, html: '<article>Private DOM must not be logged.</article>' },
    { ...observation, receiptMatches: -1 },
    { ...observation, receiptState: 'probably_waiting' },
    { ...observation, userIds: Array.from({ length: 257 }, () => 'id') },
  ]) {
    assert.equal(domReaderObservationSchema.safeParse(value).success, false);
  }
  assert.equal(
    domReaderReadResultSchema.safeParse({ ok: false, code: 'STOPPED', observation }).success,
    false,
  );
  assert.equal(domReaderReadResultSchema.safeParse({ ok: true }).success, false);
  assert.equal(domReaderPageObservationSchema.safeParse({ mutations: -1 }).success, false);
});

test('all bounded scenario plans use real canonical receipts and valid byte-sensitive JSON', async () => {
  const bundle = await rolldown({
    input: path.resolve('apps/extension/test/browser/dom-reader-scenarios.ts'),
    platform: 'browser',
  });
  let code;
  try {
    const generated = await bundle.generate({
      format: 'iife',
      name: 'ReaderScenarios',
      codeSplitting: false,
    });
    code = generated.output[0]?.code;
  } finally {
    await bundle.close();
  }
  assert.ok(code);
  const context = createContext({ crypto, TextEncoder, TextDecoder }, { codeGeneration: { strings: false } });
  new Script(code, { filename: 'dom-reader-scenarios.fixture.js' }).runInContext(context);
  const scenarios = context.ReaderScenarios;
  const reply = JSON.parse(scenarios.READER_REPLY_TEXT);
  assert.equal(reply.protocol, 'mitter/1');
  assert.equal(reply.workerId, 'reader_worker');
  assert.equal(scenarios.READER_REPLY_TEXT.includes('\r\n'), true);
  assert.equal(scenarios.READER_REPLY_TEXT.endsWith('\r\n\t '), true);
  assert.equal(reply.note.includes('😀'), true);
  const tokens = new Set();
  for (const name of domReaderScenarioNameSchema.options) {
    const scenario = await scenarios.createDomReaderScenario(name);
    const plan = domReaderPlanSchema.parse(scenario.plan);
    assert.equal(plan.name, name);
    assert.equal(scenario.request.url, DOM_READER_URL);
    assert.equal(scenario.request.receipt.textHash === scenario.receipt.textHash, true);
    assert.match(scenario.receipt.textHash, /^[0-9a-f]{64}$/);
    assert.equal(scenario.receipt.acknowledgedUserId, 'reader-user-current');
    assert.equal(tokens.has(scenario.request.token), false);
    tokens.add(scenario.request.token);
    if (name === 'digest-assistant-progress') {
      const mixed = await scenarios.createDomReaderScenario('mixed-generating');
      assert.equal(
        JSON.stringify({ ...plan, name: mixed.plan.name }) === JSON.stringify(mixed.plan),
        true,
        'Assistant progress must start with the same full users, unknown reasoning, and Stop composer.',
      );
      const current = plan.turns[2];
      assert.ok(current);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(current.text));
      assert.equal(Buffer.from(digest).toString('hex'), scenario.receipt.textHash);
    }
    if (
      name === 'digest-duplicate-before-user' ||
      name === 'digest-earlier-user-receipt' ||
      name === 'digest-later-known-user'
    ) {
      const prior = plan.turns[0];
      const current = plan.turns[2];
      const response = plan.turns[3];
      assert.ok(prior && current && response);
      assert.equal(
        plan.turns.length,
        4,
        'The candidate change must happen while digest is held, not at mount.',
      );
      assert.equal(prior.id, 'reader-user-prior');
      assert.equal(prior.role, 'user');
      assert.equal(current.id, 'reader-user-current');
      assert.equal(current.role, 'user');
      assert.equal(prior.text === current.text, false, 'The earlier full body must initially be different.');
      assert.equal(
        prior.text.includes(scenario.receipt.exchangeId),
        name === 'digest-earlier-user-receipt',
        'The earlier-body edit must change an already marker-eligible candidate, not only add a candidate.',
      );
      const priorDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prior.text));
      assert.notEqual(Buffer.from(priorDigest).toString('hex'), scenario.receipt.textHash);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(current.text));
      assert.equal(Buffer.from(digest).toString('hex'), scenario.receipt.textHash);
      assert.equal(response.role, 'unknown');
      assert.equal(response.controls, true);
      assert.equal(response.code, true);
      assert.equal(response.text === scenarios.READER_REPLY_TEXT, true);
      if (name === 'digest-later-known-user') {
        assert.equal(scenario.expectedUserText === DOM_READER_LATER_USER_TEXT, true);
      } else {
        assert.equal(scenario.expectedUserText === current.text, true);
      }
    }
  }
  assert.equal(domReaderPlanSchema.safeParse({ name: 'mixed-generating', turns: [] }).success, false);
});

test('the digest gate holds real SHA-256 completion and restores the original browser API', async () => {
  const digest = crypto.subtle.digest;
  const descriptor = Object.getOwnPropertyDescriptor(crypto.subtle, 'digest');
  try {
    installDomReaderDigestGate();
    const pending = crypto.subtle.digest('SHA-256', new TextEncoder().encode('reader gate scheduling'));
    await nextTurn();
    for (let attempt = 0; attempt < 100 && inspectDomReaderDigestGate().calls === 0; attempt++) {
      await nextTurn();
    }
    assert.deepEqual(inspectDomReaderDigestGate(), { calls: 1, held: true });
    assert.throws(installDomReaderDigestGate, /already installed/);
    releaseDomReaderDigestGate();
    assert.equal((await pending).byteLength, 32);
    assert.equal(crypto.subtle.digest, digest);
    assert.deepEqual(Object.getOwnPropertyDescriptor(crypto.subtle, 'digest'), descriptor);
    assert.deepEqual(inspectDomReaderDigestGate(), { calls: 0, held: false });
  } finally {
    releaseDomReaderDigestGate();
  }
});

test('offline interception fulfills only one exact GET Document in the owned top frame', async () => {
  const fixture = interceptorFixture();
  const event =
    JSON.stringify({ sessionId: 'reader-session', method: 'Fetch.requestPaused', params: pausedRequest() }) +
    '\0';
  fixture.output.write(event.slice(0, 17));
  assert.equal(fixture.commands.length, 0);
  fixture.output.write(event.slice(17));
  await nextTurn();
  fixture.offline.check();
  const command = fixture.commands[0];
  assert.equal(command?.method, 'Fetch.fulfillRequest');
  assert.equal(command?.session, 'reader-session');
  assert.equal(Buffer.from(command.params.body, 'base64').toString('utf8') === DOM_READER_HTML, true);
  assert.deepEqual(
    command.params.responseHeaders.find((header) => header.name === 'Content-Security-Policy'),
    {
      name: 'Content-Security-Policy',
      value: DOM_READER_POLICY,
    },
  );
  fixture.emit(pausedRequest({ requestId: 'duplicate-navigation' }));
  await nextTurn();
  assert.equal(fixture.commands[1]?.method, 'Fetch.failRequest');
  assert.equal(fixture.offline.fulfilled, 1);
  fixture.output.removeListener('data', fixture.offline.receive);
});

test('offline interception fails every other request and cancels authentication without continuing traffic', async () => {
  const fixture = interceptorFixture();
  fixture.emit(pausedRequest(), 'another-session');
  assert.equal(fixture.commands.length, 0);
  for (const request of [
    pausedRequest({ frameId: 'child-frame' }),
    pausedRequest({ resourceType: 'Fetch' }),
    pausedRequest({ request: { method: 'POST', url: DOM_READER_URL } }),
    pausedRequest({ request: { method: 'GET', url: DOM_READER_URL + '?private=1' } }),
    pausedRequest({
      request: { method: 'GET', url: 'https://chatgpt.com.attacker.invalid/c/reader-fixture' },
    }),
    pausedRequest({ request: { method: 'GET', url: 'https://chatgpt.com/backend-api/conversations' } }),
  ]) {
    fixture.emit(request);
  }
  fixture.emit(pausedRequest(), 'reader-session', 'Fetch.authRequired');
  await nextTurn();
  assert.equal(fixture.offline.fulfilled, 0);
  assert.equal(fixture.offline.blocked, 7);
  assert.equal(fixture.commands.filter((command) => command.method === 'Fetch.failRequest').length, 6);
  assert.equal(
    fixture.commands.some((command) => command.method === 'Fetch.continueRequest'),
    false,
  );
  assert.equal(fixture.commands.at(-1)?.params.authChallengeResponse.response, 'CancelAuth');
  fixture.output.removeListener('data', fixture.offline.receive);
});

test('interception rejects malformed events and bounds both pipe fragments and request traffic', async () => {
  const malformed = interceptorFixture();
  malformed.emit({ requestId: 'missing-request-fields' });
  assert.equal(malformed.killed(), true);
  assert.throws(() => malformed.offline.check(), /interceptor failed/);
  malformed.output.removeListener('data', malformed.offline.receive);
  const oversized = interceptorFixture();
  oversized.output.write('x'.repeat(8 * 1024 * 1024 + 1));
  assert.equal(oversized.killed(), true);
  oversized.output.removeListener('data', oversized.offline.receive);
  const flood = interceptorFixture();
  for (let index = 0; index < 17; index++) {
    flood.emit(pausedRequest({ requestId: 'blocked-' + index, frameId: 'child-frame' }));
  }
  assert.equal(flood.killed(), true);
  await nextTurn();
  flood.output.removeListener('data', flood.offline.receive);
});

test('target shutdown removes the scoped event listener even when target closure fails', async () => {
  const fixture = interceptorFixture(async (method) => {
    if (method === 'Target.closeTarget') {
      throw new Error('Target closure failed.');
    }
    return {};
  });
  assert.equal(fixture.output.listenerCount('data'), 1);
  await assert.rejects(fixture.offline.close(), /Target closure failed/);
  assert.equal(fixture.output.listenerCount('data'), 0);
  assert.equal(fixture.offline.buffer, '');
  assert.equal(
    fixture.commands.some((command) => command.method === 'Fetch.disable'),
    false,
  );
});

test('the offline target enables Request-stage interception and bypasses cache/workers before navigation', async () => {
  const output = new PassThrough();
  output.setEncoding('utf8');
  const commands = [];
  let enabled = false;
  const chrome = {
    child: { stdio: [undefined, undefined, undefined, undefined, output] },
    kill() {},
    async request(method, params) {
      commands.push({ method, params });
      if (method === 'Target.createTarget') {
        return { targetId: 'target' };
      }
      if (method === 'Target.attachToTarget') {
        return { sessionId: 'session' };
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'frame', url: 'about:blank' } } };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { type: 'boolean', value: true } };
      }
      if (method === 'Fetch.enable') {
        enabled = true;
      }
      if (method === 'Page.navigate') {
        if (params.url === DOM_READER_URL) {
          assert.equal(enabled, true);
          output.write(
            JSON.stringify({
              method: 'Fetch.requestPaused',
              sessionId: 'session',
              params: pausedRequest({ frameId: 'frame' }),
            }) + '\0',
          );
        }
        return { frameId: 'frame' };
      }
      if (method === 'Target.closeTarget') {
        return { success: true };
      }
      return {};
    },
  };
  const offline = await openDomReaderOfflinePage(chrome);
  assert.equal(offline.fulfilled, 1);
  const interception = commands.findIndex((command) => command.method === 'Fetch.enable');
  const navigation = commands.findIndex(
    (command) => command.method === 'Page.navigate' && command.params.url === DOM_READER_URL,
  );
  assert.ok(interception < navigation);
  assert.equal(
    commands.some(
      (command) => command.method === 'Network.setBypassServiceWorker' && command.params.bypass === true,
    ),
    true,
  );
  assert.equal(
    commands.some(
      (command) => command.method === 'Network.setCacheDisabled' && command.params.cacheDisabled === true,
    ),
    true,
  );
  await offline.close();
  assert.equal(output.listenerCount('data'), 0);
});

test('the headless permission setup grants only the declared host and closes its owned Chrome settings tab', async () => {
  const commands = [];
  const id = 'a'.repeat(32);
  const chrome = {
    async request(method, params) {
      commands.push({ method, params });
      if (method === 'Target.createTarget') {
        return { targetId: 'settings' };
      }
      if (method === 'Target.attachToTarget') {
        return { sessionId: 'settings-session' };
      }
      if (method === 'Page.navigate') {
        return { frameId: 'settings-frame' };
      }
      if (method === 'Runtime.evaluate') {
        if (params.expression.includes('addHostPermission')) {
          return { result: { type: 'undefined' } };
        }
        return { result: { type: 'boolean', value: true } };
      }
      if (method === 'Target.closeTarget') {
        return { success: true };
      }
      return {};
    },
  };
  await grantDomReaderHostPermission(chrome, 'fixture-session', id);
  const granting = commands.find((command) => command.params.expression?.includes('addHostPermission'));
  assert.equal(
    granting.params.expression,
    'chrome.developerPrivate.addHostPermission("' + id + "\", 'https://chatgpt.com/*')",
  );
  assert.deepEqual(commands.at(-1), { method: 'Target.closeTarget', params: { targetId: 'settings' } });
  const refused = { request: async () => ({ result: { type: 'boolean', value: false } }) };
  await assert.rejects(
    grantDomReaderHostPermission(refused, 'fixture-session', id),
    /Do not grant undeclared origins/,
  );
});
