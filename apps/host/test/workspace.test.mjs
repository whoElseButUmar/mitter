import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  Workspace,
  atomicWrite,
  fileText,
  safePath,
  validateRelative,
  existing,
} from '../src/core/workspace.js';
import { digest, editContent } from '../src/core/edit-plan.js';
import { temporaryDirectory, memoryStore, projectFixture, envelopeFixture } from './fixtures.mjs';
test('workspace rejects sensitive/traversal paths, symlinks and hardlinks', async (t) => {
  const root = await temporaryDirectory(t);
  const outside = await temporaryDirectory(t);
  await fs.writeFile(path.join(outside, 'private.txt'), 'do not read');
  await fs.symlink(outside, path.join(root, 'link'));
  await assert.rejects(safePath(root, 'link/private.txt'), /Symbolic links/);
  await fs.writeFile(path.join(root, 'source.txt'), 'source');
  await fs.link(path.join(root, 'source.txt'), path.join(root, 'hard.txt'));
  await assert.rejects(fileText(root, 'hard.txt'), /Hard-linked/);

  for (const relative of ['../outside', '.env.local', '.git/config', 'a\\b', '/tmp/file', 'CON.txt']) {
    assert.throws(() => validateRelative(relative));
  }
  assert.equal(validateRelative('.', true), '.');
});
test(
  'atomic publication preserves BOM/CRLF and never overwrites a stale or ' + 'newly created file',
  async (t) => {
    const root = await temporaryDirectory(t);
    const original = '﻿one\r\ntwo\r\n';
    await atomicWrite(root, 'file.txt', original, 'missing');
    assert.deepEqual(await fileText(root, 'file.txt'), {
      content: original,
      hash: digest(original),
    });
    await assert.rejects(atomicWrite(root, 'file.txt', 'replace', 'missing'), /Stale edit/);
    await assert.rejects(atomicWrite(root, 'file.txt', 'replace', digest('stale')), /Stale edit/);
    assert.equal((await fileText(root, 'file.txt')).content, original);
    assert.equal(
      (await fs.readdir(root)).some((name) => name.startsWith('.mitter-tmp-')),
      false,
    );
    assert.deepEqual(await existing(root, 'missing.txt'), {
      content: null,
      hash: 'missing',
    });
  },
);
test(
  'consecutive replacements rebase only within the verified batch and ' + 'recover cursor lag',
  async (t) => {
    const root = await temporaryDirectory(t);
    const store = memoryStore(t);
    const project = projectFixture(root);
    const workspace = new Workspace(store);
    await fs.writeFile(path.join(root, 'file.txt'), 'alpha beta');
    const initialHash = digest('alpha beta');
    const batch = envelopeFixture([
      {
        type: 'replace',
        path: 'file.txt',
        before: 'alpha',
        after: 'ALPHA',
        expectedHash: initialHash,
      },
      {
        type: 'replace',
        path: 'file.txt',
        before: 'beta',
        after: '$&`BETA',
        expectedHash: initialHash,
      },
    ]);
    const plan = await workspace.plan(project, 'worker', 'run', batch, 0);
    assert.equal(plan.steps[1].after.content, 'ALPHA $&`BETA');

    for (const step of plan.steps) {
      await workspace.commitStep(project, 'worker', 'run', step);
    }

    const recovered = await workspace.plan(project, 'worker', 'run', batch, 0);
    assert.equal(
      recovered.steps.every((step) => step.done),
      true,
    );
    await workspace.commitStep(project, 'worker', 'run', recovered.steps[0]);
    assert.equal((await fileText(root, 'file.txt')).content, 'ALPHA $&`BETA');
    await workspace.rollback(project, 'run');
    assert.equal((await fileText(root, 'file.txt')).content, 'alpha beta');
  },
);
test('prepared journals recover only the exact before/after, preserving ' + 'external edits', async (t) => {
  const root = await temporaryDirectory(t);
  const store = memoryStore(t);
  const project = projectFixture(root);
  const workspace = new Workspace(store);
  const action = {
    type: 'write',
    path: 'new.txt',
    content: 'prepared',
    expectedHash: 'missing',
  };
  store.prepareWrite({
    id: 'edit',
    workerId: 'worker',
    runId: 'run',
    path: 'new.txt',
    before: null,
    after: 'prepared',
    beforeHash: 'missing',
    afterHash: digest('prepared'),
    status: 'prepared',
    time: Date.now(),
  });
  assert.equal((await workspace.write(project, 'worker', 'run', 'edit', action)).recovered, true);
  assert.equal(store.journal('edit').status, 'applied');
  await fs.writeFile(path.join(root, 'new.txt'), 'user edit');
  await assert.rejects(workspace.write(project, 'worker', 'run', 'edit', action), /ambiguous/);
  await assert.rejects(workspace.rollback(project, 'run'), /Rollback conflict/);
  assert.equal((await fileText(root, 'new.txt')).content, 'user edit');
});
test(
  'replacement uniqueness counts overlapping matches and preserves ' + 'literal replacement syntax',
  () => {
    const action = {
      type: 'replace',
      path: 'file',
      before: 'aa',
      after: '$&',
      expectedHash: digest('aaa'),
    };
    assert.throws(
      () =>
        editContent(action, {
          content: 'aaa',
          hash: digest('aaa'),
        }),
      /multiple matches/,
    );
    assert.equal(
      editContent(
        {
          ...action,
          before: 'aaa',
        },
        {
          content: 'aaa',
          hash: digest('aaa'),
        },
      ).content,
      '$&',
    );
  },
);
