import assert from 'node:assert/strict';
import test from 'node:test';
import { assetChunkSchema } from '../src/core/assets.js';
import { stateBackupSchema } from '../src/core/backups.js';
import { teamMessageSchema } from '../src/core/collaboration.js';
import { commandProfileInputSchema, commandResultSchema } from '../src/core/commands.js';
import { fileVersionSchema, digest } from '../src/core/edit-plan.js';
import { handoffDeliverySchema } from '../src/core/handoff-delivery.js';
import { healthSchema } from '../src/core/health.js';
import {
  helperCheckSchema,
  nativeTerminalCheckSchema,
  nativeTerminalOptionsSchema,
} from '../src/core/pty-runtime.js';
import { helperOptionsSchema } from '../src/core/terminal/helper-check.js';
import { terminalRequestSchema } from '../src/core/terminal/requests.js';
import {
  readVersionSchema,
  readLedgerSchema,
  readPageSchema,
  readResultSchema,
} from '../src/core/read-snapshots.js';
import { resetFailureSchema, resetResultSchema } from '../src/core/reset.js';
import { fileReviewSchema } from '../src/core/review.js';
import {
  changedFileSchema,
  firstFileChangeSchema,
  lastFileChangeSchema,
  fileChangeSchema,
  journalSchema,
  skippedEditSchema,
} from '../src/core/storage-schemas.js';
import { syntaxCheckSchema } from '../src/core/syntax-check.js';
import { fileTextSchema, searchMatchSchema } from '../src/core/workspace/files.js';
import { workspaceWriteSchema, workspaceRollbackSchema } from '../src/core/workspace/journal.js';
import { runtimeOptionsSchema } from '../src/runtime.js';
import { databaseVersionSchema, databaseValueSchema, databaseTableSchema } from '../src/adapters/sqlite.js';
import { skippedEditSchema as serviceSkippedEditSchema } from '../src/core/service/schemas.js';

const contracts = {
  assetChunkSchema,
  stateBackupSchema,
  teamMessageSchema,
  commandProfileInputSchema,
  commandResultSchema,
  fileVersionSchema,
  handoffDeliverySchema,
  healthSchema,
  helperCheckSchema,
  nativeTerminalCheckSchema,
  nativeTerminalOptionsSchema,
  helperOptionsSchema,
  readVersionSchema,
  readLedgerSchema,
  readPageSchema,
  readResultSchema,
  resetFailureSchema,
  resetResultSchema,
  fileReviewSchema,
  changedFileSchema,
  firstFileChangeSchema,
  lastFileChangeSchema,
  journalSchema,
  skippedEditSchema,
  syntaxCheckSchema,
  fileTextSchema,
  searchMatchSchema,
  workspaceWriteSchema,
  workspaceRollbackSchema,
  runtimeOptionsSchema,
  databaseVersionSchema,
  databaseValueSchema,
  databaseTableSchema,
};

test('host-owned serialized contracts describe their fields, restrictions and units', () => {
  for (const [name, schema] of Object.entries(contracts)) {
    assert.equal(typeof schema.description, 'string', name);

    for (const [fieldName, field] of Object.entries(schema.shape)) {
      assert.equal(typeof field.description, 'string', name + '.' + fieldName);
      assert.ok(field.description.length > 0, name + '.' + fieldName);
    }
  }

  for (const schema of Object.values(healthSchema.shape)) {
    if (schema.shape) {
      for (const field of Object.values(schema.shape)) {
        assert.equal(typeof field.description, 'string');
      }
    }
  }

  for (const variant of terminalRequestSchema.options) {
    assert.equal(typeof variant.shape.method.description, 'string');

    for (const field of Object.values(variant.shape.params.shape)) {
      assert.equal(typeof field.description, 'string', variant.shape.method.value);
    }
  }
});

test('skip writers and edit-history readers share one canonical receipt schema', () => {
  assert.equal(serviceSkippedEditSchema, skippedEditSchema);
  const receipt = { workerId: 'worker_1', runId: 'run_1', actionHash: digest('literal action') };
  assert.deepEqual(skippedEditSchema.parse(receipt), receipt);

  for (const changed of [
    { workerId: 12 },
    { workerId: 'not an identifier' },
    { runId: null },
    { actionHash: 'missing' },
  ]) {
    assert.equal(serviceSkippedEditSchema.safeParse({ ...receipt, ...changed }).success, false);
    assert.equal(skippedEditSchema.safeParse({ ...receipt, ...changed }).success, false);
  }
});

test('file-change contracts verify literal BOM, CRLF and Unicode content without normalizing hashes', () => {
  const before = '\ufeffbefore\r\n界';
  const after = '\ufeffafter\r\n界';
  const record = { before, beforeHash: digest(before), after, afterHash: digest(after), status: 'applied' };
  assert.deepEqual(fileChangeSchema.parse(record), record);
  assert.equal(
    fileChangeSchema.safeParse({ ...record, before: before.replace('\r\n', '\n') }).success,
    false,
  );
  assert.equal(fileChangeSchema.safeParse({ ...record, after: after.slice(1) }).success, false);
  assert.equal(fileChangeSchema.safeParse({ ...record, before: null }).success, false);
  assert.equal(fileChangeSchema.safeParse({ ...record, before: null, beforeHash: 'missing' }).success, true);
});
