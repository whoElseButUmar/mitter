import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, makeWorker } from './test-fixture.mjs';
import { buildCompletion } from './reports.ts';
import {
  completionRecordSchema,
  parseRpcResult,
  coreRpcRegistry,
} from '../../../../../packages/protocol/src/index.ts';

test('readiness can be inspected before a task starts without changing saved task state', async (context) => {
  const { service, worker, store } = await fixture(context);
  const before = JSON.stringify(worker);
  const events = store.events();
  const result = await service.handle('system.readiness', {});

  assert.deepEqual(parseRpcResult(coreRpcRegistry, 'system.readiness', result), result);
  assert.equal(JSON.stringify(worker), before);
  assert.deepEqual(store.events(), events);
  await assert.rejects(service.handle('system.readiness', { root: '/tmp' }));
  await service.close();
  await assert.rejects(service.handle('system.readiness', {}), /shutting down/);
});

function quality(name, ok = true) {
  return { check: { type: 'quality', name }, ok };
}

test('web completion records source and domain evidence without claiming rendered checks', () => {
  const results = ['skills', 'components', 'syntax', 'tests', 'snapshot'].map((name) => quality(name));
  const completion = buildCompletion(makeWorker(), 'passed', 'Finished.', results.length, 1, results);

  assert.deepEqual(completionRecordSchema.parse(completion), completion);
  assert.equal(completion.evidence.source, 'passed');
  assert.equal(completion.evidence.domain, 'passed');
  assert.equal(completion.evidence.browser, 'not-run');
  assert.match(completion.evidence.detail, /do not verify rendered UI, accessibility or live HTTP behavior/);
  assert.equal(
    completionRecordSchema.safeParse({
      ...completion,
      evidence: { ...completion.evidence, browser: 'fabricated' },
    }).success,
    false,
  );
});

test('browser completion needs fresh snapshot and both actual browser gates', () => {
  const results = ['components', 'syntax', 'tests', 'browser', 'lighthouse', 'snapshot'].map((name) =>
    quality(name),
  );
  const complete = buildCompletion(makeWorker(), 'passed', 'Done.', results.length, 1, results);
  assert.equal(complete.evidence.browser, 'passed');
  assert.equal(complete.evidence.lighthouse, 'passed');
  assert.match(complete.evidence.detail, /does not establish WCAG conformance/);
  for (const failed of ['browser', 'lighthouse', 'snapshot']) {
    const failedResults = results.map((result) => {
      if (result.check.name === failed) {
        return { ...result, ok: false };
      }
      return result;
    });
    const completion = buildCompletion(makeWorker(), 'passed', 'Done.', results.length, 1, failedResults);
    if (failed === 'snapshot' || failed === 'browser') {
      assert.equal(completion.evidence.browser, 'not-run');
    }
    if (failed === 'snapshot' || failed === 'lighthouse') {
      assert.equal(completion.evidence.lighthouse, 'not-run');
    }
  }
});

test('partial or changed source evidence cannot become verified domain or source completion', () => {
  const incomplete = [quality('components'), quality('syntax'), quality('tests')];

  for (const results of [incomplete, [...incomplete, quality('snapshot', false)]]) {
    const completion = buildCompletion(makeWorker(), 'passed', 'Done.', results.length, 1, results);
    assert.equal(completion.evidence.source, 'not-run');
    assert.equal(completion.evidence.domain, 'not-run');
  }

  const sourceOnly = [quality('components'), quality('syntax'), quality('snapshot')];
  const completion = buildCompletion(makeWorker(), 'passed', 'Done.', sourceOnly.length, 1, sourceOnly);
  assert.equal(completion.evidence.source, 'passed');
  assert.equal(completion.evidence.domain, 'not-run');
});

test('older and non-web completions do not acquire manufactured evidence', () => {
  const legacy = { version: 1, verification: 'legacy-accepted', summary: 'Done.', checked: 0, at: 1 };
  assert.deepEqual(completionRecordSchema.parse(legacy), legacy);
  const completion = buildCompletion(makeWorker(), 'passed', 'Done.', 1, 1, [
    { check: { type: 'exists', path: 'note.txt' }, ok: true },
  ]);
  assert.equal(completion.evidence, undefined);
});

test('only successful host-owned framework checks authorize automatic launch of the exact captured sources', () => {
  const devServer = 'vite';
  const devServerFingerprint = 'a'.repeat(64);
  const detail = JSON.stringify({ devServer, devServerFingerprint });
  const run = (results) =>
    buildCompletion(makeWorker(), 'passed', 'Done.', results.length, 1, results).evidence;
  const checked = { ...quality('browser'), detail };
  assert.equal(run([checked, quality('snapshot')]).devServer, undefined);
  assert.equal(
    run([checked, quality('lighthouse'), quality('snapshot')]).devServerFingerprint,
    devServerFingerprint,
  );
  const ready = run([{ ...quality('dev-server'), detail }]);
  assert.equal(ready.devServer, devServer);
  assert.equal(ready.browser, 'not-run');
  assert.equal(ready.lighthouse, 'not-run');
  assert.equal(run([{ ...quality('dev-server'), detail: 'not JSON' }]).devServer, undefined);
});

test('static preview evidence requires passing browser, Lighthouse and unchanged snapshot checks', () => {
  const staticPreview = { entry: 'sub/app.html', fingerprint: '9'.repeat(64) };
  const checked = { ...quality('browser'), detail: JSON.stringify({ staticPreview }) };
  const run = (results) =>
    buildCompletion(makeWorker(), 'passed', 'Done', results.length, 1, results).evidence;
  assert.deepEqual(run([checked, quality('lighthouse'), quality('snapshot')]).staticPreview, staticPreview);
  assert.equal(run([checked, quality('snapshot')]).staticPreview, undefined);
  assert.equal(run([checked, quality('lighthouse'), quality('snapshot', false)]).staticPreview, undefined);
  assert.equal(run([quality('dev-server'), quality('snapshot')]).staticPreview, undefined);
});
