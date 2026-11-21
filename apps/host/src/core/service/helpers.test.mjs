import '../../../../../packages/bridge/src/runner/test-source-loader.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeEnvelope, makeWorker, digest } from './test-fixture.mjs';

const {
  localProposalSchema,
  workerCreationSchema,
  parseLocalProposal,
  parseWorkerCreation,
  parseHandoffText,
  parseDisplayName,
} = await import('./request-parsing.ts');
const { sameCodeSelection } = await import('../followups.ts');
const { projectContextSchema } = await import('./project-catalog.ts');
const { recoverInterruptedWorker, recoverStoppedWorker, migrateLegacyCompletion } =
  await import('./state-migration.ts');
const { summarizeAction, buildCompletion, buildReport, completionEventMessage, completionFailureMessage } =
  await import('./reports.ts');
const { buildEditRepair, encodeRepairObservation } = await import('./edit-repair.ts');
const { EditConflict } = await import('../edit-plan.ts');
const schemas = await import('./schemas.ts');

test('creation keeps legacy defaults, names, and literal false command trust', () => {
  const creation = parseWorkerCreation({
    mode: 'handoff',
    goal: '  Preserve this task.  ',
    name: '  ',
    autoCommands: true,
    checks: null,
  });
  assert.equal(creation.goal, '  Preserve this task.  ');
  assert.ok(creation.name.length > 0);
  assert.equal(creation.maxIterations, 8);
  assert.equal(creation.maxMinutes, 15);
  assert.deepEqual(creation.checks, []);
  assert.deepEqual(workerCreationSchema.parse(creation), creation);
  assert.equal('autoCommands' in creation, false);

  for (const params of [
    { goal: '   ' },
    { goal: 'x'.repeat(4001) },
    { goal: 'bad\0goal' },
    { mode: 'pretend' },
    { maxIterations: 0 },
    { maxMinutes: 241 },
    { checks: [{ type: 'exists', path: '../outside' }] },
    { name: 12 },
  ]) {
    assert.throws(() =>
      parseWorkerCreation({
        mode: 'local',
        goal: 'Keep files.',
        ...params,
      }),
    );
  }
});

test('local proposals stay small and strict without replacing exact edit bases', () => {
  const action = {
    type: 'replace',
    path: 'file.txt',
    before: 'old',
    after: 'new',
    base: 'r_0123456789abcdef',
  };
  assert.deepEqual(
    parseLocalProposal({
      summary: '  Keep literal whitespace.  ',
      actions: [action],
    }),
    {
      summary: '  Keep literal whitespace.  ',
      actions: [action],
    },
  );
  assert.throws(() => parseLocalProposal({ summary: 'Plan.', actions: [] }), /1–8/);
  assert.throws(
    () =>
      parseLocalProposal({
        summary: 'Plan.',
        actions: Array(9).fill(action),
      }),
    /1–8/,
  );
  assert.throws(() =>
    parseLocalProposal({
      summary: 'Plan.',
      actions: [action],
      extra: true,
    }),
  );
  assert.throws(
    () =>
      parseLocalProposal({
        summary: 'Plan.',
        actions: [{ ...action, expectedHash: 'a'.repeat(64) }],
      }),
    /either base or expectedHash/,
  );
  assert.throws(() => parseHandoffText('界'.repeat(220000)), /too large/i);
  assert.throws(
    () =>
      parseLocalProposal({
        summary: 'Copy the controls.',
        actions: [
          { type: 'write', path: 'large.txt', base: 'missing', content: '界'.repeat(120_000) },
          { type: 'write', path: 'next.txt', base: 'missing', content: '界'.repeat(12_000) },
          { type: 'write', path: 'components.mjs', asset: 'components.mjs', base: 'missing' },
        ],
      }),
    (error) => error.issue?.code === 'PROPOSAL_TOO_LARGE',
  );
  assert.equal(parseDisplayName('  name  ', 'task name'), 'name');
  assert.throws(() => parseDisplayName('  ', 'task name'), /Invalid task name/);
});

test('selection equality ignores key order but compares every field and absence', () => {
  const selection = {
    path: 'file.txt',
    hash: 'a'.repeat(64),
    start: 0,
    end: 4,
    text: 'same',
  };
  const reordered = {
    text: 'same',
    end: 4,
    start: 0,
    hash: 'a'.repeat(64),
    path: 'file.txt',
  };
  assert.equal(sameCodeSelection(selection, reordered), true);
  assert.equal(sameCodeSelection(undefined, undefined), true);
  assert.equal(sameCodeSelection(selection, undefined), false);
  assert.equal(sameCodeSelection(undefined, selection), false);

  for (const changed of [
    { path: 'other.txt' },
    { hash: 'b'.repeat(64) },
    { start: 1 },
    { end: 5 },
    { text: 'else' },
  ]) {
    assert.equal(sameCodeSelection(selection, { ...selection, ...changed }), false);
    assert.equal(sameCodeSelection({ ...selection, ...changed }, selection), false);
  }
});

test('pure recovery pauses uncertain work without discarding its committed-history identity', () => {
  const worker = makeWorker({
    state: 'executing',
    cursor: 1,
    autoCommands: true,
    approvedFingerprint: 'old',
    queue: [makeEnvelope(makeWorker(), [{ type: 'read', path: 'file.txt' }])],
  });
  const recovered = recoverInterruptedWorker(worker);
  assert.equal(worker.state, 'executing');
  assert.equal(recovered.state, 'paused');
  assert.equal(recovered.runId, worker.runId);
  assert.deepEqual(recovered.queue, worker.queue);
  assert.equal(recovered.cursor, 1);
  assert.equal(recovered.approvedFingerprint, undefined);
  assert.match(recovered.error, /never blindly replayed/);

  const stopped = recoverStoppedWorker({
    ...recovered,
    control: {
      version: 1,
      epoch: 2,
      mode: 'stopped',
      at: 1,
      operationId: 'stop_1',
      reason: 'Stopped.',
      retiredExchanges: [],
    },
  });
  assert.equal(stopped.runId, worker.runId);
  assert.deepEqual(stopped.queue, []);
  assert.equal(stopped.cursor, 0);
  assert.equal(stopped.humanAcceptanceReady, false);
});

test('legacy completion never upgrades intermediate review, errors, approvals, or stops', () => {
  const finished = makeWorker({
    state: 'review',
    humanAcceptanceReady: true,
    activeFollowupId: 'followup_1',
  });
  const completed = migrateLegacyCompletion(finished, 100);
  assert.equal(finished.state, 'review');
  assert.equal(completed.state, 'complete');
  assert.equal(completed.completion.verification, 'not-run');
  assert.equal(completed.completion.followupId, 'followup_1');
  assert.equal(completed.completion.at, 100);
  const checked = migrateLegacyCompletion(
    { ...finished, checks: [{ type: 'exists', path: 'file.txt' }] },
    100,
  );
  assert.equal(checked.completion.verification, 'passed');

  for (const overrides of [
    { humanAcceptanceReady: false },
    { error: 'Unknown effects.' },
    { pending: { token: 'approval_1' } },
    { queue: [makeEnvelope(finished, [{ type: 'read', path: 'file.txt' }])] },
    { control: { mode: 'stopped' } },
    { state: 'paused' },
  ]) {
    const unfinished = { ...finished, ...overrides };
    assert.equal(migrateLegacyCompletion(unfinished, 100), unfinished);
  }
});

test('repair status prioritizes bounded, redacted findings over raw check metadata', () => {
  const host = 'http://miter-' + 'a'.repeat(32) + '.localhost:54899/' + 'b'.repeat(32) + '/';
  const message = completionFailureMessage([
    { check: { type: 'quality', name: 'skills' }, ok: true, detail: 'Passed' },
    {
      check: { type: 'quality', name: 'browser' },
      ok: false,
      finding: 'desktop / Open match: blocked opening ' + host + 'index.html?player=O',
      detail: '{"reports":["private/report.json"]}',
    },
    {
      check: { type: 'command', profileId: 'test' },
      ok: false,
      detail: { code: 1, stdout: '', stderr: 'token=veryprivate ' + 'x'.repeat(10000) },
    },
    { check: { type: 'contains', path: 'result.txt', text: 'ready' }, ok: false },
    { check: { type: 'exists', path: 'other.txt' }, ok: false },
  ]);
  assert.match(message, /Chrome: desktop \/ Open match: blocked opening \/index\.html\?player=O/);
  assert.match(message, /test: token=\[REDACTED\]/);
  assert.match(message, /result.txt must contain "ready"/);
  assert.match(message, /Additional failed checks: 1/);
  assert.doesNotMatch(message, /veryprivate|private\/report|localhost|Passed/);
  assert.ok(message.length < 700);
});

test('snapshot and report builders preserve their exact content boundaries', () => {
  const write = {
    type: 'write',
    path: 'file.txt',
    content: 'secret source',
    expectedHash: 'missing',
  };
  const replace = {
    type: 'replace',
    path: 'file.txt',
    before: 'a'.repeat(300),
    after: 'b'.repeat(300),
    expectedHash: 'a'.repeat(64),
  };
  assert.equal(summarizeAction(write).content, '[13 characters; omitted from status]');
  assert.equal(write.content, 'secret source');
  assert.equal(summarizeAction(replace).before.length, 180);
  assert.equal(summarizeAction(replace).after.length, 180);
  const read = { type: 'read', path: 'file.txt' };
  assert.equal(summarizeAction(read), read);

  const worker = makeWorker();
  assert.equal('followupId' in buildCompletion(worker, 'not-run', 'Done.', 0, 100), false);
  const files = Array.from({ length: 70 }, (_, index) => ({
    path: 'file_' + index,
    status: 'applied',
    bytes: 1,
  }));
  const report = buildReport(worker, { name: 'Project' }, '', files);
  assert.match(report, /^MITTER REPORT — local project results\nProject: Project\n/);
  assert.ok(report.includes('file_63: applied'));
  assert.equal(report.includes('file_64: applied'), false);
  assert.match(report, /Completion: null\nError: none/);
  assert.ok(report.endsWith('Redaction is best effort, not a guarantee.\n'));
});

test('completion events name only the quality checks supported by the recorded evidence', () => {
  const worker = makeWorker();
  function checked(names) {
    const results = names.map((name) => ({ check: { type: 'quality', name }, ok: true }));
    return buildCompletion(worker, 'passed', 'Done.', results.length, 100, results);
  }

  const complete = checked(['components', 'syntax', 'tests', 'browser', 'lighthouse', 'snapshot']);
  assert.equal(
    completionEventMessage(complete),
    'Finished. Checks passed: source, domain, browser, Lighthouse.',
  );
  assert.equal(complete.evidence.browser, 'passed');
  assert.equal(complete.evidence.lighthouse, 'passed');

  const backend = ['desktop', 'mobile'].map((device) => ({ device, journey: 'Save a record' }));
  for (const devices of [[], backend.slice(0, 1), backend]) {
    const checks = ['browser', 'lighthouse', 'snapshot'].map((name) => ({
      check: { type: 'quality', name },
      ok: true,
      detail: JSON.stringify({ backend: devices }),
    }));
    const recorded = buildCompletion(worker, 'passed', 'Done.', checks.length, 100, checks);
    assert.equal(recorded.evidence.detail.includes('running backend'), devices.length === 2);
  }

  const sourceOnly = checked(['components', 'syntax', 'tests', 'snapshot']);
  assert.equal(
    completionEventMessage(sourceOnly),
    'Finished. Checks passed: source, domain. Not run: browser, Lighthouse.',
  );

  const browserWithoutLighthouse = checked(['browser', 'snapshot']);
  assert.equal(
    completionEventMessage(browserWithoutLighthouse),
    'Finished. Checks passed: browser. Not run: source, domain, Lighthouse.',
  );

  const missingSnapshot = checked(['components', 'syntax', 'tests', 'browser', 'lighthouse']);
  assert.equal(
    completionEventMessage(missingSnapshot),
    'Finished. Not run: source, domain, browser, Lighthouse.',
  );

  const historical = structuredClone(sourceOnly);
  delete historical.evidence.lighthouse;
  assert.equal(
    completionEventMessage(historical),
    'Finished. Checks passed: source, domain. Not run: browser. Not recorded: Lighthouse.',
  );

  const unchecked = buildCompletion(worker, 'not-run', 'Done.', 0, 100);
  assert.equal(completionEventMessage(unchecked), 'Finished. No completion checks were configured.');
  assert.equal(
    completionEventMessage({ ...complete, verification: 'legacy-accepted' }),
    'Finished. Passing verification was not recorded.',
  );
});

test('repair observations remain whole JSON while the full audit keeps exact file evidence', () => {
  const worker = makeWorker();
  const batch = makeEnvelope(worker, [{ type: 'read', path: 'file.txt' }]);
  const content = '\\"\n'.repeat(1500);
  const current = {
    path: 'file.txt',
    hash: digest(content),
    bytes: Buffer.byteLength(content),
    content,
  };
  const writes = Array.from({ length: 100 }, (_, index) => ({
    id: batch.id + '_' + index,
    path: 'p'.repeat(900) + index,
    status: 'applied',
    afterHash: 'a'.repeat(64),
  }));
  const pending = Array.from({ length: 100 }, (_, index) => ({
    ...batch,
    id: 'batch_' + index,
  }));
  const repair = buildEditRepair(
    batch,
    0,
    pending,
    new EditConflict('STALE_EDIT', 'file.txt', 'Stale.', 0),
    current,
    writes,
  );
  const encoded = encodeRepairObservation(repair);
  const observation = JSON.parse(encoded).editRepair;
  assert.ok(encoded.length <= 12000);
  schemas.editRepairObservationSchema.parse(observation);
  assert.equal(observation.current.content, undefined);
  assert.equal(observation.current.contentOmitted, true);
  assert.ok(observation.appliedOmitted > 0);
  assert.equal(repair.current.content, content);
  assert.equal(repair.applied.length, 100);
  assert.equal(repair.discarded.length, 100);
});

test('serialized service-owned contracts have simple descriptions and validate retry evidence', () => {
  for (const schema of [localProposalSchema, workerCreationSchema, projectContextSchema]) {
    assert.equal(typeof schema.description, 'string');

    for (const field of Object.values(schema.shape)) {
      assert.equal(typeof field.description, 'string');
    }
  }

  assert.equal(localProposalSchema.safeParse({ summary: 12, actions: [{ type: 'diff' }] }).success, false);
  for (const name of [
    'controlResultSchema',
    'controlOperationSchema',
    'retiredQueueSchema',
    'controlArchiveSchema',
    'skippedEditSchema',
    'verificationIntentSchema',
    'checkResultSchema',
    'followupActivationSchema',
    'editRepairSchema',
    'editRepairArchiveSchema',
    'editRepairObservationSchema',
  ]) {
    const schema = schemas[name];
    assert.equal(typeof schema.description, 'string', name);

    for (const [fieldName, field] of Object.entries(schema.shape)) {
      assert.equal(typeof field.description, 'string', name + '.' + fieldName);
    }
  }

  assert.equal(typeof schemas.verificationResultSchema.description, 'string');
  for (const variant of schemas.verificationResultSchema.options) {
    assert.equal(typeof variant.description, 'string');
    for (const field of Object.values(variant.shape)) {
      assert.equal(typeof field.description, 'string');
    }
  }

  const failedVerification = {
    ok: false,
    results: [{ check: { type: 'exists', path: 'missing.txt' }, ok: false }],
    requiresHumanAcceptance: false,
    verification: 'failed',
    summary: 'Not complete.',
  };
  assert.equal(schemas.verificationResultSchema.safeParse(failedVerification).success, true);
  assert.equal(
    schemas.verificationResultSchema.safeParse({ ...failedVerification, verification: 'passed' }).success,
    false,
  );

  assert.throws(() => schemas.readControlOperation({ signature: 'a'.repeat(64) }, 'control_1'), /invalid/);
  assert.equal(
    schemas.commandJournalSchema.safeParse({
      status: 'finished',
      workerId: 'worker_1',
      result: { code: 0 },
    }).success,
    false,
  );
  assert.equal(schemas.readControlOperation(undefined, 'control_1'), undefined);
});
