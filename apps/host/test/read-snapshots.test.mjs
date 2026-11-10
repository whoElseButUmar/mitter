import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ReadSnapshots, readPageSchema, readResultSchema } from '../src/core/read-snapshots.js';
import { digest } from '../src/core/workspace.js';
import { matchingDelivery, deliveryKey } from '../src/core/handoff-delivery.js';
import {
  temporaryDirectory,
  memoryStore,
  workerFixture,
  projectFixture,
  envelopeFixture,
} from './fixtures.mjs';
test(
  'read bases require full unredacted coverage for writes and expire ' + 'across run boundaries',
  async (t) => {
    const root = await temporaryDirectory(t);
    const store = memoryStore(t);
    const reads = new ReadSnapshots(store);
    const worker = workerFixture();
    const project = projectFixture(root);
    await fs.writeFile(path.join(root, 'source.txt'), 'hello world');
    const first = await reads.read(
      worker,
      project,
      {
        type: 'read',
        path: 'source.txt',
        limit: 5,
      },
      new AbortController().signal,
    );
    assert.equal(first.readComplete, false);
    const proposal = envelopeFixture([
      {
        type: 'write',
        path: 'source.txt',
        content: 'updated',
        base: first.base,
      },
    ]);
    assert.throws(() => reads.resolve(worker, project, proposal), /complete, unredacted read/);
    await reads.read(
      worker,
      project,
      {
        type: 'read',
        path: 'source.txt',
        offset: 5,
      },
      new AbortController().signal,
    );
    const resolved = reads.resolve(worker, project, proposal);
    assert.equal(resolved.actions[0].expectedHash, digest('hello world'));

    // A base is immutable; live-disk conflict checks happen at edit planning, not here.
    await fs.writeFile(path.join(root, 'source.txt'), 'external edit');
    assert.equal(reads.resolve(worker, project, proposal).actions[0].expectedHash, digest('hello world'));
    worker.runId = 'new-run';
    assert.throws(() => reads.resolve(worker, project, proposal), /not a recorded read/);
  },
);
test(
  'read ledgers reject damaged records, redact secrets and preserve ' + 'Unicode page boundaries',
  async (t) => {
    const root = await temporaryDirectory(t);
    const store = memoryStore(t);
    const reads = new ReadSnapshots(store);
    const worker = workerFixture();
    const project = projectFixture(root);
    await fs.writeFile(path.join(root, 'unicode.txt'), '😀text');
    const page = await reads.read(
      worker,
      project,
      {
        type: 'read',
        path: 'unicode.txt',
        limit: 1,
      },
      new AbortController().signal,
    );
    assert.equal(page.content, '😀');
    await assert.rejects(
      reads.read(
        worker,
        project,
        {
          type: 'read',
          path: 'unicode.txt',
          offset: 1,
        },
        new AbortController().signal,
      ),
      /Unicode/,
    );
    await fs.writeFile(path.join(root, 'source.txt'), 'api_key="supersecretvalue"');
    const redacted = await reads.read(
      worker,
      project,
      {
        type: 'read',
        path: 'source.txt',
      },
      new AbortController().signal,
    );
    assert.equal(redacted.readComplete, false);
    assert.deepEqual(readResultSchema.parse(redacted), redacted);
    assert.equal(redacted.content.includes('supersecretvalue'), false);
    assert.throws(
      () =>
        reads.resolve(
          worker,
          project,
          envelopeFixture([
            {
              type: 'write',
              path: 'source.txt',
              content: 'new',
              base: redacted.base,
            },
          ]),
        ),
      /complete, unredacted read/,
    );
    store.set('miter.readSnapshots.v1.worker', {
      version: 1,
      reads: [
        {
          hash: 'invented',
        },
      ],
    });
    assert.throws(() => reads.resolve(worker, project, envelopeFixture([])), /not valid/);
  },
);
test('final read-result parsing preserves cumulative completeness and page validation', async (t) => {
  const root = await temporaryDirectory(t);
  const reads = new ReadSnapshots(memoryStore(t));
  const worker = workerFixture();
  const project = projectFixture(root);
  await fs.writeFile(path.join(root, 'source.txt'), 'hello world');

  const first = await reads.read(
    worker,
    project,
    {
      type: 'read',
      path: 'source.txt',
      limit: 5,
    },
    new AbortController().signal,
  );
  const parsedFirst = readResultSchema.parse(first);
  assert.deepEqual(parsedFirst, first);
  assert.equal(parsedFirst.readComplete, false);
  assert.equal(parsedFirst.nextOffset, 5);

  const pageOnly = readPageSchema.parse(first);
  assert.equal(Object.hasOwn(pageOnly, 'readComplete'), false);
  assert.throws(() => readResultSchema.parse(pageOnly));
  assert.throws(() => readResultSchema.parse({ ...first, readComplete: 'false' }));

  const remaining = await reads.read(
    worker,
    project,
    {
      type: 'read',
      path: 'source.txt',
      offset: 5,
    },
    new AbortController().signal,
  );
  const parsedRemaining = readResultSchema.parse(remaining);
  assert.deepEqual(parsedRemaining, remaining);
  assert.equal(parsedRemaining.complete, false);
  assert.equal(parsedRemaining.readComplete, true);
  assert.throws(() => readResultSchema.parse({ ...remaining, hash: 'invalid' }));
});

test('handoff acknowledgement is bound to the exact owner, run, epoch and ' + 'body hash', (t) => {
  const store = memoryStore(t);
  const worker = workerFixture();
  const hash = digest('envelope body');
  store.rememberEnvelope('batch', worker.id);
  const receipt = {
    version: 1,
    workerId: worker.id,
    projectId: worker.projectId,
    runId: worker.runId,
    epoch: 0,
    hash,
    started: false,
  };
  store.set(deliveryKey('batch'), receipt);
  assert.deepEqual(matchingDelivery(store, worker, 'batch', hash), receipt);
  assert.throws(() => matchingDelivery(store, worker, 'batch', digest('changed')), /does not match/);
  store.set(deliveryKey('batch'), {
    ...receipt,
    started: 'yes',
  });
  assert.throws(() => matchingDelivery(store, worker, 'batch', hash));
});
