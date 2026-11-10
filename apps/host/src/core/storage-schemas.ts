import { z } from 'zod';
import { createHash } from 'node:crypto';
import { identifierSchema } from '../../../../packages/protocol/src/schemas/primitives.js';
export {
  workerStateSchema,
  profileSchema,
  projectSchema,
  workerSchema,
  activitySchema,
} from '../../../../packages/protocol/src/index.js';

import { sha256Schema, fileHashSchema } from '../../../../packages/protocol/src/rpc.js';
export { sha256Schema, fileHashSchema, changedFileSchema } from '../../../../packages/protocol/src/rpc.js';

export const journalSchema = z
  .object({
    id: z.string().describe('Exact action identifier.'),
    workerId: z.string().describe('The worker that prepared this edit.'),
    runId: z.string().describe('The run that prepared this edit.'),
    path: z.string().describe('Project-relative path checked before filesystem access.'),
    before: z.string().nullable().describe('Original source, or null for a newly created file.'),
    after: z.string().describe('Prepared replacement source.'),
    beforeHash: fileHashSchema,
    afterHash: sha256Schema,
    status: z.string().describe('Journal lifecycle status; replay checks eligible states explicitly.'),
    time: z.number().finite().nonnegative().describe('Preparation time in Unix milliseconds.'),
  })
  .refine(
    (journal) => {
      let beforeHash = 'missing';

      if (journal.before !== null) {
        beforeHash = createHash('sha256').update(journal.before).digest('hex');
      }

      const afterHash = createHash('sha256').update(journal.after).digest('hex');

      return journal.beforeHash === beforeHash && journal.afterHash === afterHash;
    },
    {
      message: 'Journal content does not match its recorded file hashes. Files were ' + 'preserved.',
    },
  )
  .describe('An immutable file-edit journal record with verified before/after ' + 'content hashes.');

export const firstFileChangeSchema = z
  .object({
    before: z
      .string()
      .nullable()
      .describe('The exact original source, or null when the run created the file.'),
    beforeHash: fileHashSchema.describe('The digest of the original source, or missing for a new file.'),
  })
  .refine(
    (record) => {
      let expected = 'missing';

      if (record.before !== null) {
        expected = createHash('sha256').update(record.before).digest('hex');
      }

      return record.beforeHash === expected;
    },
    { message: 'Journal content does not match its recorded file hashes. Files were preserved.' },
  )
  .describe('The original version of a journaled file change, with its content hash verified.');

export const lastFileChangeSchema = z
  .object({
    after: z.string().describe('The exact latest replacement source retained for this run.'),
    afterHash: sha256Schema.describe('The SHA-256 of the latest replacement source.'),
    status: z.string().describe('The lifecycle status of the latest retained edit.'),
  })
  .refine((record) => record.afterHash === createHash('sha256').update(record.after).digest('hex'), {
    message: 'Journal content does not match its recorded file hashes. Files were preserved.',
  })
  .describe('The latest retained version of a journaled file change, with its content hash verified.');

export const fileChangeSchema = firstFileChangeSchema
  .and(lastFileChangeSchema)
  .describe('Verified original and latest source versions used for recorded file review.');

export const skippedEditSchema = z
  .object({
    workerId: identifierSchema('worker ID').describe('The task that explicitly skipped this edit.'),
    runId: identifierSchema('run ID').describe('The exact run containing the skipped edit.'),
    actionHash: sha256Schema.describe('The fingerprint of the literal skipped action, not its file content.'),
  })
  .describe('An explicit skip receipt bound to one exact action and run.');
