import assert from 'node:assert/strict';
import { test } from 'node:test';
import './test-source-loader.mjs';

const { conversationURL, chatStartURL, isTaskBootstrap, normalizeMessage } =
  await import('./chat-identity.ts');
const {
  buildExchangeMessage,
  buildReportPrompt,
  buildCorrectionPrompt,
  buildTaskLinkCorrection,
  buildMissingResponsePrompt,
} = await import('./prompts.ts');
const { parseAssistantReply, checkReplyExchange, replyFingerprint } = await import('./reply-validation.ts');
const { recoverTaskProgress } = await import('./progress-recovery.ts');
const { checkpointShape } = await import('./checkpoint-writer.ts');

const { assistantReadShape, userReadShape } = await import('./reader-diagnostics.ts');
const { wrapMessage, unwrapMessage } = await import('../message-wire.ts');

const worker = {
  id: 'worker_1',
  projectId: 'project_1',
  goal: 'Keep source bytes intact.',
};
const exchangeId = '11111111-1111-4111-8111-111111111111';
const goalHash = 'a'.repeat(64);
const receipt = {
  workerId: worker.id,
  projectId: worker.projectId,
  goalHash,
  textHash: 'b'.repeat(64),
  renderedHash: 'b'.repeat(64),
  at: 100,
  exchangeId,
  expectsReplyTo: true,
  turn: 3,
};
const options = { maxTurns: 5, maxMinutes: 10, lastReceipt: receipt };
const reply = {
  protocol: 'mitter/1',
  id: 'reply_1',
  replyTo: exchangeId,
  workerId: worker.id,
  projectId: worker.projectId,
  summary: 'Inspect files',
  actions: [{ type: 'list', path: '.' }],
};
const replyView = {
  assistantId: reply.id,
  assistantText: JSON.stringify(reply),
  assistantFormat: 'code',
};

function savedProgress(overrides = {}) {
  return {
    version: 1,
    revision: 5,
    workerId: worker.id,
    projectId: worker.projectId,
    goalHash,
    turns: 4,
    maxTurns: 8,
    lowerBound: false,
    activeMs: 7000,
    maxMinutes: 12,
    startedAt: 10,
    updatedAt: 90,
    stage: 'waiting_reply',
    lastReceipt: receipt,
    repeats: 1,
    formatRepairs: 1,
    phase: 'waiting_reply',
    reason: 'Waiting.',
    ...overrides,
  };
}

test('conversation routes normalize only supported ChatGPT conversations', () => {
  assert.equal(
    conversationURL('https://chatgpt.com/c/task-1/?mode=test#reply'),
    'https://chatgpt.com/c/task-1',
  );
  assert.equal(
    conversationURL('https://chat.openai.com/g/custom/c/task-1/'),
    'https://chat.openai.com/g/custom/c/task-1',
  );
  for (const url of [
    'https://example.com/c/task-1',
    'http://chatgpt.com/c/task-1',
    'https://chatgpt.com/c/',
    'https://chatgpt.com/c/task_1',
    'https://chatgpt.com/settings',
  ]) {
    assert.throws(() => conversationURL(url));
  }
});

test('new-chat roots require explicit permission, not just a trusted origin', () => {
  assert.equal(chatStartURL('https://chatgpt.com/?temporary=true', true), 'https://chatgpt.com');
  assert.equal(chatStartURL('https://chat.openai.com/', true), 'https://chat.openai.com');
  assert.throws(() => chatStartURL('https://chatgpt.com/'));
  assert.throws(() => chatStartURL('https://chatgpt.com/settings', true));
  assert.throws(() => chatStartURL('not a URL', true));
});

test('legacy bootstrap recognition binds the literal goal and escaped task identifiers', () => {
  const task = {
    id: 'worker.+',
    projectId: 'project[1]',
    goal: 'A verbatim goal',
  };
  const bootstrap = `You are collaborating with Mitter, in an older template.\nGOAL: ${task.goal}\n{"protocol":"mitter/1","workerId":"${task.id}","projectId":"${task.projectId}"}\nFor THIS ChatGPT handoff`;
  assert.equal(isTaskBootstrap(bootstrap, task), true);
  assert.equal(isTaskBootstrap(wrapMessage(bootstrap, exchangeId), task), true);
  assert.equal(isTaskBootstrap(bootstrap.replace('worker.+', 'workerXYZ'), task), false);
  assert.equal(isTaskBootstrap(bootstrap, { ...task, goal: 'A different goal' }), false);
  assert.equal(isTaskBootstrap(bootstrap.replace('For THIS ChatGPT handoff', ''), task), false);
  assert.equal(normalizeMessage(' \r\nword word\r\n '), 'word word');
});

test('exchange messages reproduce the contract byte-for-byte and preserve untrusted reports', () => {
  const example = JSON.stringify(
    {
      protocol: 'mitter/1',
      id: 'REPLACE_WITH_A_NEW_UNIQUE_ID_EVERY_TURN',
      workerId: worker.id,
      projectId: worker.projectId,
      summary: 'What this batch does',
      actions: [{ type: 'list', path: '.' }],
    },
    null,
    2,
  );
  const linkedExample = JSON.stringify(
    {
      protocol: 'mitter/1',
      id: 'REPLACE_WITH_A_NEW_UNIQUE_ID_EVERY_TURN',
      replyTo: exchangeId,
      workerId: worker.id,
      projectId: worker.projectId,
      summary: 'What this batch does',
      actions: [{ type: 'list', path: '.' }],
    },
    null,
    2,
  );
  const report = `BEGIN UNTRUSTED MITTER REPORT\n${example}\nconst source = \`\\n\`;\n\`\`\`\`\`\`\nEND UNTRUSTED MITTER REPORT`;
  const text = `Template:\n${example}\n${example}\n${report}`;
  const message = buildExchangeMessage(text, exchangeId, worker);
  const payload = unwrapMessage(message).payload;
  const contract =
    'CURRENT REPLY CONTRACT (this exchange only)\n' +
    JSON.stringify(
      {
        protocol: 'mitter/1',
        id: 'NEW_UNIQUE_REPLY_ID',
        replyTo: exchangeId,
        workerId: worker.id,
        projectId: worker.projectId,
      },
      null,
      2,
    ) +
    '\nThese are required envelope headers, not a complete action batch. Add the required summary string and actions array using the action schema below. Return exactly one fenced json block. Include "replyTo": "' +
    exchangeId +
    '" at the top level. Do not reuse a replyTo from an earlier turn. Use a new unique id. Use ordinary ASCII indentation; do not HTML-encode JSON whitespace or add Markdown backslashes at line endings. The action schema, permissions and checks are unchanged.';
  assert.equal(
    message,
    wrapMessage(
      contract + '\n\n' + `Template:\n${linkedExample}\n${example}\n${report}` + '\n\n' + contract,
      exchangeId,
    ),
  );
  assert.equal(
    payload.slice(payload.indexOf('BEGIN UNTRUSTED MITTER REPORT'), -('\n\n' + contract).length),
    report,
  );
  assert.equal(buildExchangeMessage(text, exchangeId, worker), message);
});

test('contract building handles prompts without reports and rejects invalid nonces', () => {
  const message = buildExchangeMessage('Goal with literal `code` and \\backslashes', exchangeId, worker);
  assert.match(unwrapMessage(message).payload, /Goal with literal `code` and \\backslashes/);
  assert.throws(() => buildExchangeMessage('Goal', 'not-a-uuid', worker));
});

test('report and correction helpers retain literal reports and the same recovery instructions', () => {
  const report = 'File: `test`\n\\n stays literal';
  const prompt = buildReportPrompt('Next step', report);
  assert.equal(
    prompt,
    `Next step\n\nBEGIN UNTRUSTED MITTER REPORT\n${report}\nEND UNTRUSTED MITTER REPORT\n\nReturn only the next complete mitter/1 JSON object inside one fenced code block labeled json. No commentary outside the block.`,
  );
  assert.ok(
    buildCorrectionPrompt(prompt, 'Schema issue', 2, true).startsWith(
      prompt + '\n\nACTION DATA CORRECTION 2/2:',
    ),
  );
  assert.ok(
    buildCorrectionPrompt(prompt, 'Format issue', 1, false).startsWith(
      prompt + '\n\nTRANSPORT CORRECTION 1/2:',
    ),
  );
  assert.ok(buildTaskLinkCorrection(prompt).startsWith(prompt + '\n\nTASK-LINK CORRECTION:'));
  assert.ok(buildMissingResponsePrompt('Next step').startsWith('Next step\n\nMISSING RESPONSE RECOVERY\n'));
});

test('explicit stale nonces cannot be overridden by fenced transcript evidence', () => {
  assert.deepEqual(parseAssistantReply(replyView, receipt), reply);
  assert.throws(() => checkReplyExchange({ ...reply, replyTo: 'older_exchange' }, receipt, 'code'), {
    code: 'REPLY_LINK_MISSING',
  });
  const { replyTo, ...legacyReply } = reply;
  assert.doesNotThrow(() => checkReplyExchange(legacyReply, receipt, 'code'));
  assert.throws(() => checkReplyExchange(legacyReply, receipt, 'plain'), {
    code: 'REPLY_LINK_MISSING',
  });
  assert.doesNotThrow(() => checkReplyExchange(legacyReply, undefined, 'plain'));
});

test('plain replies remain read-only even when their nonce matches', () => {
  assert.deepEqual(parseAssistantReply({ ...replyView, assistantFormat: 'plain' }, receipt), reply);
  const edit = {
    ...reply,
    actions: [
      {
        type: 'write',
        path: 'file.txt',
        content: '`literal`\\text\n',
        expectedHash: 'missing',
      },
    ],
  };
  assert.throws(
    () =>
      parseAssistantReply(
        {
          ...replyView,
          assistantFormat: 'plain',
          assistantText: JSON.stringify(edit),
        },
        receipt,
      ),
    { code: 'REPLY_FORMAT' },
  );
  assert.deepEqual(parseAssistantReply({ ...replyView, assistantText: JSON.stringify(edit) }, receipt), edit);
});

test('extraction issues and schema errors fail before any envelope can be accepted', () => {
  for (const issue of [
    'MULTIPLE_BLOCKS',
    'EXTRA_CONTENT',
    'MARKDOWN_TRANSFORMED',
    'CODE_NOT_VISIBLE',
    'EMPTY_CODE_BLOCK',
    'PLAIN_STRING_LAYOUT',
    'PLAIN_HIDDEN_CONTENT',
    'PAYLOAD_TOO_LARGE',
    'unknown',
  ]) {
    assert.throws(() => parseAssistantReply({ ...replyView, assistantReadIssue: issue }, receipt), {
      code: 'REPLY_FORMAT',
    });
  }
  assert.throws(() =>
    parseAssistantReply(
      {
        ...replyView,
        assistantText: JSON.stringify({
          ...reply,
          actions: [{ type: 'unknown' }],
        }),
      },
      receipt,
    ),
  );
});

test('reply stability fingerprints include extraction format and errors', () => {
  assert.notEqual(replyFingerprint(replyView), replyFingerprint({ ...replyView, assistantFormat: 'plain' }));
  assert.notEqual(
    replyFingerprint(replyView),
    replyFingerprint({ ...replyView, assistantReadIssue: 'EXTRA_CONTENT' }),
  );
});

test('legacy progress uses known lower bounds instead of resetting turn history', () => {
  const recovered = recoverTaskProgress(
    { progress: null, importedCount: 7 },
    worker,
    options,
    goalHash,
    () => 200,
  );
  assert.equal(recovered.turns, 7);
  assert.equal(recovered.maxTurns, 7);
  assert.equal(recovered.lowerBound, true);
  assert.equal(recovered.stage, 'waiting_reply');
  assert.deepEqual(recovered.lastReceipt, receipt);
});

test('progress migration ignores receipts for other tasks or retired host execution plans', () => {
  const foreign = recoverTaskProgress(
    { progress: null, importedCount: 0 },
    worker,
    { ...options, lastReceipt: { ...receipt, goalHash: 'c'.repeat(64) } },
    goalHash,
    () => 200,
  );
  assert.equal(foreign.lastReceipt, undefined);
  assert.equal(foreign.stage, 'ready');
  const fresh = recoverTaskProgress(
    { progress: null, importedCount: 0 },
    { ...worker, control: { mode: 'fresh' } },
    options,
    goalHash,
    () => 200,
  );
  assert.equal(fresh.lastReceipt, undefined);
  assert.equal(fresh.stage, 'report_due');
});

test('newer browser receipts advance counters without changing saved active time or budgets', () => {
  const original = savedProgress();
  const newer = { ...receipt, at: 150, turn: 6 };
  const recovered = recoverTaskProgress(
    { progress: original, importedCount: 5 },
    worker,
    { ...options, lastReceipt: newer },
    goalHash,
    () => 200,
  );
  assert.equal(recovered.turns, 6);
  assert.equal(recovered.maxTurns, 8);
  assert.equal(recovered.activeMs, 7000);
  assert.equal(recovered.maxMinutes, 12);
  assert.equal(recovered.startedAt, 10);
  assert.equal(recovered.formatRepairs, 1);
  assert.equal(recovered.lowerBound, true);
  assert.equal(original.turns, 4);
  assert.equal(original.lastReceipt.at, 100);
});

test('older browser metadata cannot roll back newer host progress', () => {
  const original = savedProgress({
    turns: 6,
    lastReceipt: { ...receipt, at: 300, turn: 6 },
  });
  const recovered = recoverTaskProgress(
    { progress: original, importedCount: 2 },
    worker,
    options,
    goalHash,
    () => 400,
  );
  assert.equal(recovered.turns, 6);
  assert.equal(recovered.lastReceipt.at, 300);
});

test('invalid or differently bound progress is rejected, not silently reset', () => {
  assert.throws(
    () =>
      recoverTaskProgress(
        { progress: { ...savedProgress(), version: 2 }, importedCount: 0 },
        worker,
        options,
        goalHash,
        () => 200,
      ),
    { code: 'PROGRESS_VERSION' },
  );
  assert.throws(
    () =>
      recoverTaskProgress(
        {
          progress: savedProgress({
            projectId: 'other_project',
            lastReceipt: undefined,
          }),
          importedCount: 0,
        },
        worker,
        options,
        goalHash,
        () => 200,
      ),
    { code: 'PROGRESS_BINDING' },
  );
});

test('legacy display metadata is normalized before enforcing the current load contract', () => {
  const legacy = savedProgress({
    phase: undefined,
    reason: undefined,
    errorCode: 'invalid legacy code',
    lastReceipt: { ...receipt, messageId: 'invalid legacy id' },
  });
  const recovered = recoverTaskProgress(
    { progress: legacy, importedCount: 2 },
    worker,
    { ...options, lastReceipt: undefined },
    goalHash,
    () => 200,
  );
  assert.equal(recovered.phase, 'stopped');
  assert.equal(recovered.reason, 'Progress saved.');
  assert.equal(recovered.errorCode, undefined);
  assert.equal(recovered.lastReceipt.messageId, undefined);
  assert.equal(recovered.turns, 4);
  assert.equal(recovered.maxTurns, 8);
  assert.equal(recovered.activeMs, 7000);
  assert.equal(recovered.stage, 'waiting_reply');
  assert.equal(legacy.phase, undefined);
});

test('saved display strings retain the established truncation instead of rejecting valid task history', () => {
  const recovered = recoverTaskProgress(
    {
      progress: savedProgress({
        phase: 'p'.repeat(50),
        reason: 'r'.repeat(600),
      }),
      importedCount: 2,
    },
    worker,
    options,
    goalHash,
    () => 200,
  );
  assert.equal(recovered.phase, 'p'.repeat(40));
  assert.equal(recovered.reason, 'r'.repeat(500));
  assert.equal(recovered.turns, 4);
  assert.equal(recovered.activeMs, 7000);
});

test('checkpoint heartbeat shape excludes only revision and timing metadata', () => {
  const progress = savedProgress();
  assert.equal(
    checkpointShape(progress),
    checkpointShape({
      ...progress,
      revision: 6,
      activeMs: 10000,
      updatedAt: 110,
    }),
  );
  assert.notEqual(checkpointShape(progress), checkpointShape({ ...progress, turns: 5 }));
  assert.notEqual(checkpointShape(progress), checkpointShape({ ...progress, stage: 'commit_intent' }));
});

test('structural diagnostics clamp counts and never include source or arbitrary issue text', () => {
  const shape = assistantReadShape({
    ...replyView,
    assistantReadIssue: 'secret source',
    assistantReadStats: {
      preElements: -1,
      visiblePreElements: NaN,
      nestedWrappers: 20000000,
      ignoredHiddenBlocks: 0,
      emptyBlocks: 0,
      logicalBlocks: 1,
      payloadCharacters: [3, Infinity, ...Array(10).fill(4)],
    },
  });
  assert.match(shape, /pre=0; visible=0; wrappers=10000000/);
  assert.match(shape, /sizes=3,0,4,4,4,4,4,4; issue=none/);
  assert.ok(!shape.includes('secret source'));
  const userShape = userReadShape(
    { lastUserText: 'secret source', userReader: 'untrusted', userIds: ['id'] },
    false,
    false,
    false,
    false,
    10,
  );
  assert.ok(!userShape.includes('secret source'));
  assert.match(userShape, /reader=legacy/);
});

test('browser receipt migration consistently binds new and existing progress to worker, project and goal', () => {
  const newer = { ...receipt, at: 150, turn: 6 };
  for (const foreign of [
    { ...newer, workerId: 'foreign_worker' },
    { ...newer, projectId: 'foreign_project' },
    { ...newer, goalHash: 'c'.repeat(64) },
  ]) {
    const initial = recoverTaskProgress(
      { progress: null, importedCount: 0 },
      worker,
      { ...options, lastReceipt: foreign },
      goalHash,
      () => 200,
    );
    assert.equal(initial.lastReceipt, undefined);
    assert.equal(initial.stage, 'ready');
    assert.equal(initial.turns, 0);
    const existing = recoverTaskProgress(
      { progress: savedProgress(), importedCount: 0 },
      worker,
      { ...options, lastReceipt: foreign },
      goalHash,
      () => 200,
    );
    assert.deepEqual(existing.lastReceipt, receipt);
    assert.equal(existing.turns, 4);
  }
  const controlled = recoverTaskProgress(
    { progress: savedProgress(), importedCount: 0 },
    {
      ...worker,
      control: {
        version: 1,
        epoch: 1,
        mode: 'fresh',
        at: 100,
        operationId: 'fresh_1',
        reason: 'New execution plan',
        retiredExchanges: [],
      },
    },
    { ...options, lastReceipt: newer },
    goalHash,
    () => 200,
  );
  assert.deepEqual(controlled.lastReceipt, receipt);
  assert.equal(controlled.turns, 4);
});
