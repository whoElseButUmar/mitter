import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAction, parseCheck, formatSetupCommand } from '../src/index.js';
import { parseProposalAction } from '../src/proposal.js';
import { workerSetupDecisionParamsSchema } from '../src/rpc.js';

const proposal = {
  type: 'setupCommand',
  command: ['pnpm', 'init'],
  purpose: 'Create the package manifest for the Vite project.',
  effects: 'Writes package.json in the project folder.',
};

test('a model can propose a setup command but cannot embed user approval or turn it into a finish check', () => {
  assert.deepEqual(parseAction(proposal), proposal);
  assert.deepEqual(parseProposalAction(proposal), proposal);
  assert.throws(() => parseCheck(proposal));
  assert.throws(() => parseProposalAction({ ...proposal, approved: true }));
  for (const command of ['pnpm init', [], [''], ['pnpm', 'init\nother'], ['pnpm', 'init\u202e']]) {
    assert.throws(() => parseAction({ ...proposal, command }));
  }
});

test('copy preserves spaces, empty arguments, quotes and literal shell punctuation', () => {
  assert.equal(formatSetupCommand(['pnpm', 'init']), 'pnpm init');
  assert.equal(formatSetupCommand(['time', 'compile']), "'time' compile");
  assert.equal(
    formatSetupCommand(["D:\\Sam's Tools\\run.exe", '$env:TEMP'], 'powershell'),
    "& 'D:\\Sam''s Tools\\run.exe' '$env:TEMP'",
  );
  assert.equal(formatSetupCommand(['tool', "Sam's app", '', '$HOME;']), "tool 'Sam'\\''s app' '' '$HOME;'");
});

test('setup decisions require the exact task run, token and a replacement instruction only for Do this instead', () => {
  const request = { workerId: 'worker', expectedRun: { runId: 'run_1', epoch: 0 }, token: 'once' };
  for (const decision of ['deny', 'run', 'manual']) {
    const value = { ...request, decision };
    assert.deepEqual(workerSetupDecisionParamsSchema.parse(value), value);
    assert.equal(
      workerSetupDecisionParamsSchema.safeParse({ ...value, instruction: 'run this' }).success,
      false,
    );
  }
  const alternative = { ...request, decision: 'instead', instruction: 'Use the existing pnpm workspace.' };
  assert.deepEqual(workerSetupDecisionParamsSchema.parse(alternative), alternative);
  for (const changes of [
    { instruction: ' ' },
    { expectedRun: undefined },
    { token: '' },
    { trustRun: true },
  ]) {
    assert.equal(workerSetupDecisionParamsSchema.safeParse({ ...alternative, ...changes }).success, false);
  }
});
