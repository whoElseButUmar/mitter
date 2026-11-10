import { z } from 'zod';
import { MAX_TEXT } from '../constants.js';
import { editBaseError } from '../validation.js';
import { identifierSchema, integerSchema, textSchema } from './primitives.js';

const pathSchema = textSchema('path', 1000);

export const expectedHashSchema = z
  .string({ error: editBaseError('expectedHash').message })
  .refine((value) => value === 'missing' || /^[a-f0-9]{64}$/.test(value), {
    error: editBaseError('expectedHash').message,
  })
  .describe('Exact lowercase SHA-256 from a read, or missing for a new file.');

export const readReferenceSchema = z
  .string()
  .regex(/^r_[a-f0-9]{16}$/)
  .describe('Exact opaque read-result reference; only the native host resolves it.');

export const writeBaseSchema = z
  .union([readReferenceSchema, z.literal('missing')])
  .describe('Recorded read reference, or missing for a genuinely new file.');

export const listActionSchema = z
  .strictObject({
    type: z.literal('list').describe('List a project directory.'),
    path: pathSchema
      .nullish()
      .transform((value) => value ?? '.')
      .describe('Directory path; legacy null/omitted path means the project root.'),
  })
  .describe('Executable directory-list action.');

export const readActionSchema = z
  .strictObject({
    type: z.literal('read').describe('Read an exact file page.'),
    path: pathSchema,
    offset: integerSchema('read offset', 0, 120_000).optional().describe('Optional UTF-16 page offset.'),
    limit: integerSchema('read limit', 1, 64_000).optional().describe('Optional UTF-16 page length.'),
  })
  .describe('Executable bounded file-read action.');

export const searchActionSchema = z
  .strictObject({
    type: z.literal('search').describe('Search the project.'),
    query: textSchema('query', 200),
  })
  .describe('Executable project-search action.');

export const writeActionSchema = z
  .strictObject({
    type: z.literal('write').describe('Write a file with an exact precondition.'),
    path: pathSchema,
    content: textSchema('content', MAX_TEXT, true),
    expectedHash: expectedHashSchema,
  })
  .describe('Executable exact-hash file-write action.');

export const replaceActionSchema = z
  .strictObject({
    type: z.literal('replace').describe('Replace exact text with an exact file precondition.'),
    path: pathSchema,
    before: textSchema('before', MAX_TEXT),
    after: textSchema('after', MAX_TEXT, true),
    expectedHash: expectedHashSchema,
  })
  .describe('Executable exact-hash text-replacement action.');

export const commandActionSchema = z
  .strictObject({
    type: z.literal('command').describe('Run a configured command profile, never arbitrary shell text.'),
    profileId: identifierSchema(),
  })
  .describe('Executable configured-profile action.');

export const diffActionSchema = z
  .strictObject({
    type: z.literal('diff').describe('Inspect the current project diff.'),
  })
  .describe('Executable diff-inspection action.');

export const teamMessageActionSchema = z
  .strictObject({
    type: z.literal('team_message').describe('Send a team message.'),
    message: textSchema('team message', 3000),
    to: identifierSchema('recipient').optional().describe('Optional worker recipient.'),
  })
  .describe('Executable team-message action.');

export const teamPauseActionSchema = z
  .strictObject({
    type: z.literal('team_pause').describe('Pause a team worker temporarily.'),
    workerId: identifierSchema(),
    reason: textSchema('pause reason', 1000),
    seconds: integerSchema('pause duration', 10, 300)
      .nullish()
      .transform((value) => value ?? 120)
      .describe('Pause duration; legacy null/omitted duration means 120 seconds.'),
  })
  .describe('Executable bounded team-pause action.');

export const teamResumeActionSchema = z
  .strictObject({
    type: z.literal('team_resume').describe('Resume a team worker with handoff context.'),
    workerId: identifierSchema(),
    context: textSchema('handoff context', 3000),
  })
  .describe('Executable team-resume action.');

export const finishActionSchema = z
  .strictObject({
    type: z.literal('finish').describe('Request completion subject to host checks.'),
    summary: textSchema('summary', 4000),
  })
  .describe('Executable completion-request action.');

export const askActionSchema = z
  .strictObject({
    type: z.literal('ask').describe('Ask a consequential unresolved question.'),
    question: textSchema('question', 4000),
  })
  .describe('Executable question action.');

export const actionSchema = z
  .discriminatedUnion('type', [
    listActionSchema,
    readActionSchema,
    searchActionSchema,
    writeActionSchema,
    replaceActionSchema,
    commandActionSchema,
    diffActionSchema,
    teamMessageActionSchema,
    teamPauseActionSchema,
    teamResumeActionSchema,
    finishActionSchema,
    askActionSchema,
  ])
  .describe('An executable host action; model read references are not executable preconditions.');

export const existsCheckSchema = z
  .strictObject({
    type: z.literal('exists').describe('Check that a project path exists.'),
    path: pathSchema,
  })
  .describe('File-existence completion check.');

export const containsCheckSchema = z
  .strictObject({
    type: z.literal('contains').describe('Check for exact text in a file.'),
    path: pathSchema,
    text: textSchema('text', 4000),
  })
  .describe('Exact-text completion check.');

export const commandCheckSchema = commandActionSchema.describe('Configured-command completion check.');

export const checkSchema = z
  .discriminatedUnion('type', [existsCheckSchema, containsCheckSchema, commandCheckSchema])
  .describe('A configured completion check.');

export const checksSchema = z.array(checkSchema).max(20).describe('At most 20 configured completion checks.');

export const referencedWriteSchema = writeActionSchema
  .omit({ expectedHash: true })
  .extend({
    type: writeActionSchema.shape.type.describe('Propose a file write; not yet executable.'),
    base: writeBaseSchema,
  })
  .describe('Model-proposed write requiring native-host base resolution.');

export const referencedReplaceSchema = replaceActionSchema
  .omit({ expectedHash: true })
  .extend({
    type: replaceActionSchema.shape.type.describe('Propose exact text replacement; not yet executable.'),
    base: readReferenceSchema.describe('Replacement requires an existing recorded read; never missing.'),
  })
  .describe('Model-proposed replacement requiring native-host base resolution.');

export const referencedEditSchema = z
  .union([referencedWriteSchema, referencedReplaceSchema])
  .describe('A non-executable edit using a recorded read reference.');

export const proposalActionSchema = z
  .union([actionSchema, referencedEditSchema])
  .describe('A model proposal action, retaining legacy exact-hash edit support.');

export type Action = z.infer<typeof actionSchema>;
export type Check = z.infer<typeof checkSchema>;
export type ReferencedEdit = z.infer<typeof referencedEditSchema>;
export type ProposalAction = z.infer<typeof proposalActionSchema>;
