import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../runner/test-source-loader.mjs';
import { worker } from './fixtures.mjs';
const { taskPresentation, turnLabel, budgetExhausted } = await import('../presentation.ts');

test('completion presentation keeps verification details and wins over other states', () => {
  for (const [verification, checks, detail] of [
    ['legacy-accepted', [], 'Finished. Previously accepted by you.'],
    ['passed', [], 'Finished. Configured checks passed.'],
    ['not-run', [{}], 'Finished. No automated checks configured.'],
    [undefined, [{}], 'Finished. Configured checks passed.'],
    [undefined, [], 'Finished. Verification not recorded.'],
  ]) {
    const completed = {
      ...worker,
      state: 'complete',
      completion: { verification },
      checks,
      humanAcceptanceReady: true,
      control: { mode: 'stopped' },
    };
    assert.deepEqual(taskPresentation(completed, { active: true, monitoring: true }), {
      status: 'complete',
      detail,
      start: 'Run with ChatGPT',
      tone: 'success',
    });
  }
});

test('presentation preserves review, stop, fresh-plan and bridge precedence', () => {
  assert.deepEqual(
    taskPresentation({
      ...worker,
      humanAcceptanceReady: true,
      control: { mode: 'stopped' },
    }),
    {
      status: 'review',
      detail: 'Ready for your review.',
      start: 'Run with ChatGPT',
      tone: 'normal',
    },
  );
  const stopped = taskPresentation({ ...worker, control: { mode: 'stopped' } }, { active: true });
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.start, 'Continue fresh');
  const fresh = { ...worker, control: { mode: 'fresh' } };
  assert.deepEqual(
    taskPresentation(fresh, {
      active: false,
      monitoring: true,
      reason: 'Bridge reason',
    }),
    {
      status: 'paused',
      detail: 'Ready to continue from the current files with a fresh plan.',
      start: 'Continue fresh',
      tone: 'normal',
    },
  );
  assert.deepEqual(
    taskPresentation(fresh, {
      active: true,
      monitoring: true,
      receiving: true,
      phase: 'waiting_approval',
      reason: 'Receiving',
    }),
    {
      status: 'working',
      detail: 'Receiving',
      start: 'Resume task',
      tone: 'working',
    },
  );
  assert.deepEqual(
    taskPresentation(worker, {
      active: true,
      monitoring: true,
      phase: 'waiting_approval',
      reason: 'Watch only',
    }),
    {
      status: 'needs_attention',
      detail: 'Watch only',
      start: 'Resume task',
      tone: 'error',
    },
  );
  for (const [phase, status] of [
    ['waiting_approval', 'needs_approval'],
    ['reconnecting', 'reconnecting'],
    ['connecting', 'connecting'],
    ['waiting_reply', 'working'],
  ]) {
    assert.deepEqual(taskPresentation(worker, { active: true, phase, reason: phase }), {
      status,
      detail: phase,
      start: 'Resume task',
      tone: 'working',
    });
  }
  for (const [phase, tone] of [
    ['error', 'error'],
    ['stopped', 'normal'],
  ]) {
    assert.deepEqual(taskPresentation(worker, { active: false, phase, reason: phase }), {
      status: 'paused',
      detail: phase,
      start: 'Resume task',
      tone,
    });
  }
});

test('fallback presentation and task budgets retain their exact boundaries', () => {
  assert.deepEqual(taskPresentation({ ...worker, error: 'Ignored while idle' }), {
    status: 'idle',
    detail: 'Ready when you are.',
    start: 'Run with ChatGPT',
    tone: 'normal',
  });
  assert.equal(taskPresentation({ ...worker, state: 'review' }).detail, 'Ready for the next step.');
  assert.equal(
    taskPresentation({ ...worker, state: 'review', error: 'Review error' }).detail,
    'Review error',
  );
  assert.equal(taskPresentation({ ...worker, state: 'running' }).detail, '');
  assert.equal(turnLabel({ turns: 3, maxTurns: 8, lowerBound: true }), '≥3/8 turns');
  assert.equal(turnLabel({ turns: 3, maxTurns: 8 }), '3/8 turns');
  assert.equal(budgetExhausted(undefined), false);
  assert.equal(budgetExhausted({ active: true, errorCode: 'TURN_LIMIT' }), false);
  assert.equal(budgetExhausted({ active: false, errorCode: 'TURN_LIMIT' }), true);
  assert.equal(budgetExhausted({ active: false, activeMs: 59999, maxMinutes: 1 }), false);
  assert.equal(budgetExhausted({ active: false, activeMs: 60000, maxMinutes: 1 }), true);
  assert.equal(budgetExhausted({ active: false, activeMs: NaN, maxMinutes: 1 }), false);
});
