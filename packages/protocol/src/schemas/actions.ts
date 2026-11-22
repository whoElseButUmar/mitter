import { z } from 'zod';
import { MAX_TEXT } from '../constants.js';
import { editBaseError } from '../validation.js';
import { identifierSchema, integerSchema, textSchema } from './primitives.js';
import { bundledAssetOwner, bundledTaskAssetSchema, bundledTaskSkillIdSchema } from './task-skills.js';
import { APP_COMPONENTS_JS, APP_FOUNDATION_CSS } from '../task-skills/app-design.js';
import { VITE_API_JS } from '../task-skills/vite-api.js';

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

export const skillActionSchema = z
  .strictObject({
    type: z.literal('skill').describe('Read one packaged skill without accessing the project or network.'),
    name: bundledTaskSkillIdSchema.describe('The exact name of a skill bundled with Miter.'),
    asset: bundledTaskAssetSchema.optional().describe('Optional bundled asset to read separately.'),
  })
  .refine((action) => action.asset === undefined || action.name === bundledAssetOwner[action.asset], {
    message: 'Read assets from their owning skill.',
    path: ['asset'],
  })
  .describe('Read-only access to packaged skill instructions and reference assets.');

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

// The command being approved must be visible as one line, including when copied.
const setupArgument = z
  .string()
  .max(4000)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u, {
    error: 'Use printable, single-line command arguments.',
  });

export const setupCommandActionSchema = z
  .strictObject({
    type: z.literal('setupCommand').describe('Request permission for one project setup command.'),
    command: z
      .array(setupArgument.describe('One literal executable name or argument.'))
      .min(1)
      .max(51)
      .refine((items) => !!items[0]?.trim() && items[0].length <= 1000, {
        error: 'Start the command with a program name.',
      })
      .refine((items) => items.join(' ').length <= 8000, {
        error: 'Keep each setup command under 8001 characters.',
      })
      .describe('The program followed by its exact arguments, run from the task folder.'),
    purpose: textSchema('command purpose', 500).describe(
      'What the proposed command does and why the project needs it.',
    ),
    effects: textSchema('command effects', 1000).describe(
      'Expected file, dependency, network and other changes visible to the user.',
    ),
  })
  .describe('A proposed setup command requiring a separate user decision for this occurrence.');

export const diffActionSchema = z
  .strictObject({
    type: z.literal('diff').describe('Inspect the current project diff.'),
  })
  .describe('Executable diff-inspection action.');

export const saveImageActionSchema = z
  .strictObject({
    type: z.literal('saveImage').describe('Save a raster image as a new project file.'),
    path: pathSchema.describe('New project-relative image filename, such as public/images/cover.png.'),
    source: z
      .discriminatedUnion('type', [
        z
          .strictObject({
            type: z.literal('web').describe('Import a public web image.'),
            url: z
              .url({ protocol: /^https$/ })
              .max(4096)
              .describe('Direct public HTTPS raster image URL.'),
          })
          .describe('An image available at a direct public URL.'),
        z
          .strictObject({
            type: z.literal('generated').describe('Import a rendered ChatGPT image.'),
            index: z.int().min(1).max(4).describe('One-based index of the image rendered by ChatGPT.'),
          })
          .describe('An image generated in the linked chat.'),
      ])
      .describe('Public image URL or an image produced in this task’s linked ChatGPT conversation.'),
  })
  .describe('Import a supported PNG, JPEG, WebP or GIF asset without replacing any existing file.');

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
    openPreview: z
      .literal(true)
      .optional()
      .describe(
        'Install and open an existing supported development project when the user asks to launch it.',
      ),
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
    skillActionSchema,
    writeActionSchema,
    replaceActionSchema,
    commandActionSchema,
    setupCommandActionSchema,
    saveImageActionSchema,
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

const bundledSources = {
  'components.mjs': APP_COMPONENTS_JS,
  'foundation.css': APP_FOUNDATION_CSS,
  'vite-api.mjs': VITE_API_JS,
};

export const bundledWriteSchema = z
  .union([
    writeActionSchema.omit({ content: true }).extend({ asset: bundledTaskAssetSchema }),
    referencedWriteSchema.omit({ content: true }).extend({ asset: bundledTaskAssetSchema }),
  ])
  .transform(({ asset, ...versionedWrite }) => {
    const write = { ...versionedWrite, content: bundledSources[asset] };
    if ('base' in write) {
      return referencedWriteSchema.parse(write);
    }
    return writeActionSchema.parse(write);
  })
  .describe('Copy a packaged reference into an ordinary, version-checked file write.');

export const proposalActionSchema = z
  .union([actionSchema, referencedEditSchema, bundledWriteSchema])
  .describe('A model proposal action, retaining legacy exact-hash edit support.');

export type Action = z.infer<typeof actionSchema>;
export type Check = z.infer<typeof checkSchema>;
export type ReferencedEdit = z.infer<typeof referencedEditSchema>;
export type ProposalAction = z.infer<typeof proposalActionSchema>;
