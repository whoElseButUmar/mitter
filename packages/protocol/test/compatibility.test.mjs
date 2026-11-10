import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compatibilityOutcomes, loadProtocol } from './compatibility-cases.mjs';

// Captured from the current worktree before refactoring, not from Git HEAD.
// Small fingerprints keep the broad mutation corpus out of a huge snapshot file.
const baseline = JSON.parse(readFileSync(new URL('./baseline-fingerprint.json', import.meta.url), 'utf8'));
const outcomes = compatibilityOutcomes(await loadProtocol('../src'));
const rejectedAutoStartCases = new Set([
  'followup/autostart/1',
  'followup/autostart/2',
  'followup/autostart/3',
  'followup/autostart/4',
  'followup/autostart/5',
  'followup/autostart/7',
  'followup/autostart/8',
  'followup/autostart/9',
  'followup/autostart/10',
]);
const groups = {};

for (const [name, outcome] of Object.entries(outcomes)) {
  const groupName = name.split('/')[0];

  if (!groups[groupName]) {
    groups[groupName] = {};
  }

  // Only these malformed flags intentionally stop enabling execution. Assert
  // their new errors below, and retain the original fingerprint for every other case.
  if (rejectedAutoStartCases.has(name)) {
    groups[groupName][name] = {
      ok: true,
      value: { autoStart: true, id: 'followup', instruction: 'exact draft' },
    };
  } else {
    groups[groupName][name] = outcome;
  }
}

test('the original compatibility corpus is complete', () => {
  assert.equal(Object.keys(outcomes).length, baseline.caseCount);
  assert.deepEqual(Object.keys(groups), Object.keys(baseline.groups));
});

test('only the listed malformed autoStart cases intentionally change baseline acceptance', () => {
  for (const name of rejectedAutoStartCases) {
    assert.ok(Object.hasOwn(outcomes, name), name);
    assert.deepEqual(
      outcomes[name],
      {
        ok: false,
        name: 'Error',
        message: 'Invalid autoStart. Use true or false.',
      },
      name,
    );
  }
});

for (const [name, expected] of Object.entries(baseline.groups)) {
  test('current-baseline compatibility: ' + name, () => {
    const group = groups[name];
    assert.equal(Object.keys(group).length, expected.count);
    assert.equal(createHash('sha256').update(JSON.stringify(group)).digest('hex'), expected.sha256);
  });
}
