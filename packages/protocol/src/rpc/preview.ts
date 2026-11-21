import { z } from 'zod';
import { taskBoundarySchema } from '../schemas/domain.js';
import { identifierSchema } from '../schemas/primitives.js';
import { projectParamsSchema, workerParamsSchema } from './requests.js';
import { rpcCounterSchema, rpcTimestampSchema } from './primitives.js';

// Counts cover the inputs served to Chrome, before pnpm installs dependencies.
export const previewSourceLimits = {
  static: { files: 256, fileBytes: 8 * 1024 * 1024, bytes: 24 * 1024 * 1024 },
  framework: { files: 2000, fileBytes: 32 * 1024 * 1024, bytes: 128 * 1024 * 1024 },
} as const;

export const previewIdSchema = z
  .string()
  .regex(/^[a-f0-9]{32}$/)
  .describe('The opaque identifier of one exact temporary preview session.');

const previewUrlSchema = z
  .string()
  .regex(/^http:\/\/miter-[a-f0-9]{32}\.localhost:[1-9][0-9]{0,4}\/[a-f0-9]{32}\/(?:index\.html)?$/)
  .refine(
    (value) => URL.canParse(value) && Number(new URL(value).port) <= 65535,
    'Invalid local preview port.',
  )
  .describe('The exact capability URL on this preview’s fresh loopback origin, without query or fragment.');

export const previewStatusParamsSchema = workerParamsSchema
  .strict()
  .describe('Identify the task run whose preview is being inspected.');

export const previewStartParamsSchema = previewStatusParamsSchema
  .extend({
    mode: z
      .enum(['verified', 'restart', 'run'])
      .optional()
      .describe('Run a completed app, open an audited app automatically, or restart with current files.'),
    replacePreviewId: previewIdSchema
      .optional()
      .describe('The exact running session the terminal asked to restart.'),
  })
  .refine(
    (value) => !value.replacePreviewId || value.mode === 'restart',
    'A replacement session is only valid for restart.',
  )
  .refine(
    (value) => !(value.mode === 'run' || value.replacePreviewId) || !!value.expectedRun,
    'Select the current task run.',
  )
  .describe('Serve this task’s index.html and its declared app backend on a private loopback origin.');

export const previewStopParamsSchema = previewStatusParamsSchema
  .extend({ previewId: previewIdSchema })
  .describe('Close only the named preview session; a stale request cannot close its replacement.');

export const previewStartResultSchema = z
  .strictObject({
    previewId: previewIdSchema,
    framework: z.enum(['vite', 'next']).optional().describe('The running pnpm framework, when present.'),
    url: previewUrlSchema,
    files: rpcCounterSchema
      .positive()
      .max(previewSourceLimits.framework.files)
      .describe('The number of included source files or linked static assets.'),
    bytes: rpcCounterSchema
      .positive()
      .max(previewSourceLimits.framework.bytes)
      .describe('Total included source or asset bytes before dependency installation.'),
    idleTimeoutMs: z
      .literal(1800000)
      .describe('The server closes after 30 minutes without a preview request.'),
    detail: z
      .string()
      .min(1)
      .max(1000)
      .describe('The host description of this preview’s runtime and storage.'),
  })
  .refine(
    (result) => URL.canParse(result.url) && new URL(result.url).pathname.split('/')[1] === result.previewId,
    {
      message: 'Preview URL does not match its session identifier.',
    },
  )
  .refine(
    (result) =>
      result.framework !== undefined ||
      (result.files <= previewSourceLimits.static.files && result.bytes <= previewSourceLimits.static.bytes),
    'Static preview exceeds its linked asset budget.',
  )
  .describe('The local HTTP session for opening the app in a browser.');

export const previewStatusResultSchema = z
  .strictObject({
    preview: previewStartResultSchema
      .nullable()
      .describe('The live session for this exact task boundary, or null if it has stopped.'),
  })
  .describe('The current preview session for this task run.');

export const previewStopResultSchema = z
  .strictObject({
    stopped: z
      .boolean()
      .describe('The exact session existed and was closed; false also covers expired sessions.'),
  })
  .describe('Idempotent cleanup of one exact preview session.');

export type PreviewStartResult = z.infer<typeof previewStartResultSchema>;

export const appRunLimits = { sessions: 12, output: 8192 } as const;
export const appRunListParamsSchema = projectParamsSchema
  .strict()
  .describe('Read the selected project’s app run sessions in the terminal.');

export const appRunSessionSchema = z
  .strictObject({
    previewId: previewIdSchema,
    projectId: identifierSchema('project ID'),
    workerId: identifierSchema('worker ID'),
    expectedRun: taskBoundarySchema,
    name: z.string().min(1).max(60).describe('The task name shown on the app session tab.'),
    startedAt: rpcTimestampSchema,
    state: z
      .enum(['starting', 'running', 'stopped', 'failed'])
      .describe('The current lifecycle of this exact server attempt.'),
    output: z
      .string()
      .max(appRunLimits.output)
      .describe('Bounded plain-text tail of server lifecycle and process output.'),
    url: previewUrlSchema
      .optional()
      .describe('The live capability URL while this session is serving requests.'),
  })
  .refine((row) => {
    if (row.state === 'running') {
      return !!row.url && URL.canParse(row.url) && new URL(row.url).pathname.split('/')[1] === row.previewId;
    }
    return row.url === undefined;
  }, 'A running session must have its matching local app URL.')
  .describe('An app process or HTTP server session owned by the native host.');

export const appRunListResultSchema = z
  .strictObject({
    runs: z
      .array(appRunSessionSchema)
      .max(appRunLimits.sessions)
      .describe('Recent and active runs in this project, newest first.'),
  })
  .describe('The selected project’s current and recent app runs, including their terminal output.');

export type AppRunSession = z.infer<typeof appRunSessionSchema>;
