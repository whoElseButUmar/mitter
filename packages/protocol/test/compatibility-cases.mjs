import { createHash } from 'node:crypto';

const hash = 'a'.repeat(64);
const base = 'r_' + 'b'.repeat(16);
const handoff = {
  protocol: 'mitter/1',
  id: 'batch',
  workerId: 'worker',
  projectId: 'project',
  summary: 'Inspect exactly.',
  actions: [{ type: 'diff' }],
};

export async function loadProtocol(directory) {
  const names = [
    'index',
    'proposal',
    'reply-json',
    'model-settings',
    'requests',
    'rewrite',
    'task-brief',
    'validation',
    'native-transfer',
  ];
  const modules = {};

  for (const name of names) {
    modules[name] = await import(new URL(directory + '/' + name + '.ts', import.meta.url));
  }

  return modules;
}

function normalize(value) {
  if (value === undefined) {
    return { undefined: true };
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { number: String(value) };
  }

  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (value !== null && typeof value === 'object') {
    const result = {};

    for (const key of Object.keys(value).sort()) {
      result[key] = normalize(value[key]);
    }

    return result;
  }

  return value;
}

function capture(run) {
  try {
    const value = normalize(run());
    const serialized = JSON.stringify(value);

    if (serialized.length > 1000) {
      return {
        ok: true,
        sha256: createHash('sha256').update(serialized).digest('hex'),
      };
    }

    return { ok: true, value };
  } catch (error) {
    if (!(error instanceof Error)) {
      return { ok: false, thrown: normalize(error) };
    }

    const result = { ok: false, name: error.name, message: error.message };

    if ('code' in error) {
      result.code = error.code;
    }

    if ('issue' in error) {
      result.issue = normalize(error.issue);
    }

    return result;
  }
}

export function compatibilityOutcomes(modules) {
  const results = {};

  function record(name, run) {
    results[name] = capture(run);
  }

  const actions = [
    { type: 'list' },
    { type: 'list', path: null },
    { type: 'list', path: '.' },
    { type: 'read', path: 'a.ts' },
    { type: 'read', path: 'a.ts', offset: 0, limit: 64_000 },
    { type: 'read', path: 'a.ts', offset: undefined, limit: undefined },
    { type: 'search', query: 'literal   &nbsp; \\n' },
    { type: 'write', path: 'a.ts', content: '', expectedHash: 'missing' },
    { type: 'write', path: 'a.ts', content: 'x', expectedHash: hash },
    {
      type: 'replace',
      path: 'a.ts',
      before: 'x',
      after: '',
      expectedHash: hash,
    },
    { type: 'command', profileId: 'check' },
    { type: 'diff' },
    { type: 'team_message', message: 'hello' },
    { type: 'team_message', message: 'hello', to: undefined },
    { type: 'team_message', message: 'hello', to: 'worker' },
    { type: 'team_pause', workerId: 'worker', reason: 'wait' },
    { type: 'team_pause', workerId: 'worker', reason: 'wait', seconds: null },
    { type: 'team_resume', workerId: 'worker', context: 'continue' },
    { type: 'finish', summary: 'done' },
    { type: 'ask', question: 'which?' },
    { type: 'write', path: 'a.ts', content: 'x', base },
    { type: 'replace', path: 'a.ts', before: 'x', after: '', base },
    { type: 'write', path: 'a.ts', content: 'x', base: 'missing' },
    { type: 'replace', path: 'a.ts', before: 'x', after: '', base: 'missing' },
  ];
  const invalidValues = [undefined, null, '', ' ', '\u0000', 0, false, {}, [], 'invalid/', 'x'.repeat(101)];

  for (const [index, action] of actions.entries()) {
    record('action/valid/' + index, () => modules.index.parseAction(action));
    record('proposal/valid/' + index, () => modules.proposal.parseProposalAction(action));
    record('action/extra/' + index, () => modules.index.parseAction({ ...action, unsupported: true }));
    record('proposal/extra/' + index, () =>
      modules.proposal.parseProposalAction({
        ...action,
        unsupported: true,
      }),
    );

    for (const field of Object.keys(action)) {
      for (const [invalidIndex, invalid] of invalidValues.entries()) {
        const value = { ...action, [field]: invalid };
        record('action/field/' + index + '/' + field + '/' + invalidIndex, () =>
          modules.index.parseAction(value),
        );
        record('proposal/field/' + index + '/' + field + '/' + invalidIndex, () =>
          modules.proposal.parseProposalAction(value),
        );
      }
    }
  }

  for (const [index, value] of invalidValues.entries()) {
    record('action/nonobject/' + index, () => modules.index.parseAction(value));
    record('proposal/nonobject/' + index, () => modules.proposal.parseProposalAction(value));
    record('request/nonobject/' + index, () => modules.index.parseRequest(value));
    record('settings/nonobject/' + index, () => modules['model-settings'].parseModelSettings(value));
    record('settings/restore/' + index, () => modules['model-settings'].restoreModelSettings(value));
    record('selection/nonobject/' + index, () => modules.requests.parseSelection(value));
    record('followup/nonobject/' + index, () => modules.requests.parseFollowup(value));
    record('rewrite/nonobject/' + index, () => modules.rewrite.parseRewriteRequest(value));
    record('reference/' + index, () => modules.proposal.isReadReference(value));
  }

  for (const expectedHash of [hash, hash.toUpperCase(), 'missing', 'current', ' ' + hash, hash + '\n']) {
    record('hash/' + expectedHash, () =>
      modules.index.parseAction({
        type: 'write',
        path: 'a',
        content: '',
        expectedHash,
      }),
    );
  }

  for (const value of [base, base.toUpperCase(), 'missing', base + '\n', ' ' + base, 'r_' + 'a'.repeat(15)]) {
    record('base/' + value, () =>
      modules.proposal.parseProposalAction({
        type: 'write',
        path: 'a',
        content: '',
        base: value,
      }),
    );
  }

  record('proposal/conflict', () =>
    modules.proposal.parseProposalAction({
      type: 'write',
      path: '',
      content: '',
      base,
      expectedHash: hash,
      extra: true,
    }),
  );
  record('proposal/required', () =>
    modules.proposal.parseProposalAction({
      type: 'write',
      path: '',
      content: '',
      extra: true,
    }),
  );
  record('proposal/null-hash', () =>
    modules.proposal.parseProposalAction({
      type: 'write',
      path: 'a',
      content: '',
      expectedHash: null,
    }),
  );

  const checks = [
    { type: 'exists', path: '.' },
    { type: 'contains', path: 'a', text: 'exact' },
    { type: 'command', profileId: 'check' },
    { type: 'diff' },
  ];

  for (const [index, check] of checks.entries()) {
    record('check/' + index, () => modules.index.parseCheck(check));
    record('check/extra/' + index, () => modules.index.parseCheck({ ...check, extra: true }));
  }

  for (const count of [0, 1, 20, 21]) {
    record('checks/' + count, () => {
      return modules.index.parseChecks(Array.from({ length: count }, () => checks[0]));
    });
  }

  const envelopes = [
    handoff,
    { ...handoff, replyTo: 'exchange' },
    { ...handoff, actions: [] },
    {
      ...handoff,
      actions: Array.from({ length: 16 }, () => ({ type: 'diff' })),
    },
    {
      ...handoff,
      actions: Array.from({ length: 17 }, () => ({ type: 'diff' })),
    },
    { ...handoff, actions: [{ type: 'write', path: 'a', content: '', base }] },
    {
      ...handoff,
      actions: [{ type: 'finish', summary: 'done' }, { type: 'diff' }],
    },
    {
      ...handoff,
      actions: [{ type: 'diff' }, { type: 'write', path: 'a', content: '', expectedHash: '?' }],
    },
    {
      ...handoff,
      actions: [{ type: 'write', path: 'a', content: '', base: '?' }],
    },
    {
      ...handoff,
      actions: [{ type: 'diff', extra: 'private rejected value' }],
    },
    { ...handoff, extra: true },
    { ...handoff, protocol: 'wrong', id: null, actions: [] },
    { ...handoff, id: null, actions: [{ type: 'unknown' }], replyTo: null },
    { ...handoff, actions: [{ type: 'unknown' }], replyTo: null },
  ];

  for (const field of Object.keys(handoff).concat('replyTo')) {
    for (const invalid of invalidValues) {
      envelopes.push({ ...handoff, [field]: invalid });
    }
  }

  for (const [index, envelope] of envelopes.entries()) {
    record('envelope/' + index, () => modules.index.parseEnvelope(JSON.stringify(envelope)));
    record('proposalEnvelope/' + index, () =>
      modules.proposal.parseProposalEnvelope(JSON.stringify(envelope)),
    );
  }

  record('envelope/callback', () =>
    modules.index.parseEnvelopeWith(JSON.stringify(handoff), (value) => ({
      observed: value,
    })),
  );
  record('envelope/callback-long-error', () => {
    return modules.index.parseEnvelopeWith(JSON.stringify(handoff), () => {
      throw new Error('x'.repeat(241));
    });
  });
  record('envelope/callback-unknown-error', () => {
    return modules.index.parseEnvelopeWith(JSON.stringify(handoff), () => {
      throw 'private';
    });
  });

  const requests = [
    { id: 'request', method: 'snapshot' },
    { id: 'request', method: 'snapshot', params: null },
    { id: 'request', method: 'snapshot', params: { arbitrary: true } },
    { id: 'request', method: 'snapshot', params: [] },
    { id: 'request', method: 'snapshot', extra: true },
  ];

  for (const [index, request] of requests.entries()) {
    record('request/' + index, () => modules.index.parseRequest(request));
  }

  const settings = [
    {},
    { gpu: 'cpu' },
    { gpu: 'bad', coderModelPath: null },
    { coderModelPath: null, contextSize: null, maxTokens: null, gpu: null },
    { contextSize: 2048, maxTokens: 2048 },
    { contextSize: 2048, maxTokens: 8192 },
    { coderModelPath: '\u0000', contextSize: 1, gpu: 'bad' },
    { contextSize: 32_768, maxTokens: 8192, coderModelPath: '  exact path  ' },
    { unrelated: 'ignored only by restore' },
  ];

  for (const [index, settingsValue] of settings.entries()) {
    record('settings/parse/' + index, () => modules['model-settings'].parseModelSettings(settingsValue));
    record('settings/restore-object/' + index, () =>
      modules['model-settings'].restoreModelSettings(settingsValue),
    );
  }

  record('settings/restore-inherited', () =>
    modules['model-settings'].restoreModelSettings(
      Object.create({
        coderModelPath: 'inherited',
        contextSize: 2048,
        maxTokens: 512,
        gpu: 'cpu',
      }),
    ),
  );

  const selection = { path: 'a.ts', hash, start: 0, end: 2, text: '😀' };

  for (const field of Object.keys(selection)) {
    for (const [index, invalid] of invalidValues.entries()) {
      record('selection/field/' + field + '/' + index, () =>
        modules.requests.parseSelection({ ...selection, [field]: invalid }),
      );
    }
  }

  record('selection/valid', () => modules.requests.parseSelection(selection));
  record('selection/range-first', () =>
    modules.requests.parseSelection({
      ...selection,
      path: '',
      end: 1,
    }),
  );

  for (const [index, autoStart] of invalidValues.concat(true).entries()) {
    record('followup/autostart/' + index, () =>
      modules.requests.parseFollowup({
        id: 'followup',
        instruction: '  exact draft  ',
        autoStart,
      }),
    );
  }

  record('followup/selection', () =>
    modules.requests.parseFollowup({
      id: 'followup',
      instruction: '  exact draft  ',
      selection,
    }),
  );
  record('followup/null-selection', () =>
    modules.requests.parseFollowup({
      id: 'followup',
      instruction: 'draft',
      selection: null,
    }),
  );
  record('followup/summary', () =>
    modules.requests.summarizeFollowup({
      id: 'f',
      instruction: 'x'.repeat(601),
      status: 'queued',
      createdAt: 1,
    }),
  );

  for (const mode of Object.keys(modules.rewrite.REWRITE_MODES)) {
    for (const provider of ['local', 'chatgpt']) {
      const request = {
        instruction: '  exact "draft" \u00a0 &nbsp;  ',
        mode,
        provider,
      };
      record('rewrite/request/' + mode + '/' + provider, () => modules.rewrite.parseRewriteRequest(request));
      record('rewrite/local/' + mode + '/' + provider, () => modules.rewrite.structureLocally(request));
      record('rewrite/prompt/' + mode + '/' + provider, () => {
        return modules.rewrite.rewritePrompt(request, 'request');
      });
    }
  }

  const rewriteRequest = {
    instruction: 'draft',
    mode: 'clarity',
    provider: 'local',
  };

  for (const field of Object.keys(rewriteRequest)) {
    for (const [index, invalid] of invalidValues.entries()) {
      record('rewrite/field/' + field + '/' + index, () =>
        modules.rewrite.parseRewriteRequest({
          ...rewriteRequest,
          [field]: invalid,
        }),
      );
    }
  }

  const rewriteReply = {
    protocol: 'miter-rewrite/1',
    requestId: 'request',
    text: '  exact  ',
  };
  const rewriteSources = [
    JSON.stringify(rewriteReply),
    '```JSON\n' + JSON.stringify(rewriteReply) + '\n```',
    'prose\n' + JSON.stringify(rewriteReply),
    'null',
    '[]',
    JSON.stringify({ ...rewriteReply, extra: true }),
    JSON.stringify({ ...rewriteReply, requestId: 'other' }),
    JSON.stringify({ ...rewriteReply, text: '\u0000' }),
  ];

  for (const [index, source] of rewriteSources.entries()) {
    record('rewrite/reply/' + index, () => modules.rewrite.parseRewriteReply(source, 'request'));
  }

  const sources = [
    '{}',
    '[]',
    'null',
    '{',
    '{"x":"',
    '{"x":[1,',
    '{"x":[]}',
    '{"x":[}',
    JSON.stringify(handoff),
    '```json\n' + JSON.stringify(handoff) + '\n```',
    '```JSON\n' + JSON.stringify(handoff) + '\n```',
    '{\u00a0"x":\u202f1\ufeff}',
    '{&nbsp;"x":&#32;1&#xA0;}',
    '{\\\n"x":\\\r\n1}',
    '{"x":"&nbsp;\u00a0\\\\n"}',
    '{"x":1}&nbsp;prose',
    '{"x":&quot;y&quot;}',
    '{"x":tr&nbsp;ue}',
    '{"x":1}{"x":2}',
    'prefix {} suffix',
  ];

  for (const [index, source] of sources.entries()) {
    record('json/read/' + index, () => modules['reply-json'].readReplyJSON(source));
    record('json/incomplete/' + index, () => modules['reply-json'].isIncompleteReplyJSON(source));
    record('json/normalize/' + index, () => modules['reply-json'].normalizeReplySyntax(source));
  }

  for (const value of [
    null,
    [],
    {},
    { actions: [] },
    { actions: [{ type: 'read' }] },
    { actions: [{ type: 'read', base: 'not validated here' }] },
    { actions: [{ type: 'write' }] },
  ]) {
    record('json/readOnly/' + JSON.stringify(value), () => modules['reply-json'].isReadOnlyReply(value));
  }

  for (const length of [120_000, 120_001]) {
    record('bounds/content/' + length, () =>
      modules.index.parseAction({
        type: 'write',
        path: 'a',
        content: 'x'.repeat(length),
        expectedHash: 'missing',
      }),
    );
  }

  for (const source of ['é'.repeat(200_000), 'é'.repeat(200_001)]) {
    record('bounds/bytes/' + source.length, () => modules['reply-json'].exceedsHandoffBytes(source));
  }

  const goals = [
    '',
    'make a tic-tac-toe game.',
    'fix tic-tac-toe game',
    'make a color memory game',
    'please create me an app!',
    'make an XO game',
    'Worker name: build a noughts and crosses game',
    'The goal: make a skeuomorphic game',
    'a'.repeat(80),
    'many words '.repeat(12),
    'build\nsecond line',
  ];

  for (const [index, goal] of goals.entries()) {
    record('brief/build/' + index, () => modules['task-brief'].buildTaskBrief(goal));
    record('brief/text/' + index, () => modules['task-brief'].taskBriefText(goal));
    record('brief/name/' + index, () => modules['task-brief'].suggestedTaskName(goal));
    record('brief/display/' + index, () => modules['task-brief'].displayTaskName({ name: goal, goal }));
  }

  for (const code of [
    'INVALID_BASE',
    'INVALID_EXPECTED_HASH',
    'BASE_REQUIRED',
    'BASE_CONFLICT',
    'BASE_UNAVAILABLE',
    'BASE_INCOMPLETE',
    'INVALID_ACTION',
  ]) {
    record('advice/' + code, () =>
      modules.validation.correctionAdvice({
        stage: 'schema',
        code,
        message: 'safe message',
        actionIndex: 1,
        field: 'base',
      }),
    );
  }

  record('native/passthrough', () => {
    return new modules['native-transfer'].NativeMessageInbox().accept({
      ok: true,
    });
  });
  record('native/undefined', () => modules['native-transfer'].nativeMessages(undefined, 'transfer'));
  record('native/multipart', () => {
    const payload = { text: '😀'.repeat(210_000) };
    const fragments = modules['native-transfer'].nativeMessages(payload, 'transfer');
    const inbox = new modules['native-transfer'].NativeMessageInbox(() => 0);
    const output = fragments.map((fragment) => inbox.accept(fragment));
    return { fragments: fragments.length, output };
  });

  const fragment = {
    event: 'miter.native-part/1',
    transferId: 'transfer',
    index: 0,
    parts: 2,
    characters: 2,
    text: '{',
  };

  for (const field of Object.keys(fragment)) {
    for (const [index, invalid] of invalidValues.entries()) {
      record('native/field/' + field + '/' + index, () => {
        const inbox = new modules['native-transfer'].NativeMessageInbox(() => 0);
        return inbox.accept({ ...fragment, [field]: invalid });
      });
    }
  }

  return results;
}
