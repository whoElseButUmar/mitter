import { z } from 'zod';
import { previewStartResultSchema } from './rpc/preview.js';
import { workerCreationSchema } from './rpc/requests.js';
import {
  bridgeProgressSummarySchema,
  completionRecordSchema,
  taskBoundarySchema,
  workerStateSchema,
} from './schemas/domain.js';

export const TERMINAL_CONTROL_VERSION = 1;
export const TERMINAL_CONTROL_MAX_BYTES = 256 * 1024;
export const TERMINAL_CONTROL_DESCRIPTOR = 'terminal-control.json';

const operationId = z
  .string()
  .uuid()
  .describe('The durable caller-generated operation identifier. Reuse only for the exact same request.');
const workerId = z.string().min(1).max(200).describe('The saved Miter task identifier.');
const timestamp = z.number().int().nonnegative().describe('Unix time in whole milliseconds.');

export const terminalStartParamsSchema = z
  .strictObject({
    requestId: operationId,
    projectPath: z
      .string()
      .min(1)
      .max(2000)
      .describe('The absolute project folder selected by the terminal caller.'),
    createProject: z
      .boolean()
      .describe('Explicit permission to create this one folder when absent; parents must exist.'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .optional()
      .describe('Optional task display name; otherwise Miter suggests a name from the goal.'),
    goal: workerCreationSchema.shape.goal,
    maxTurns: z.number().int().min(1).max(20).default(20).describe('Initial automatic chat turn budget.'),
    maxMinutes: z
      .number()
      .int()
      .min(1)
      .max(60)
      .default(60)
      .describe('Initial automatic active-time budget in minutes.'),
    consent: z.literal(true).describe('The terminal caller authorizes sending this project task to ChatGPT.'),
  })
  .describe(
    'Start one new ChatGPT task through the existing browser runner. Commands retain their ordinary approval requirements.',
  );

export const terminalStopParamsSchema = z
  .strictObject({
    requestId: operationId,
    workerId,
    expectedRun: taskBoundarySchema,
  })
  .describe('Stop only the task run and epoch that the terminal caller reviewed.');

export const terminalResumeParamsSchema = terminalStopParamsSchema.describe(
  'Resume the exact reviewed task run in its saved conversation, retaining remaining budgets and ordinary approval requirements.',
);

export const terminalPreviewParamsSchema = terminalStopParamsSchema
  .omit({ requestId: true })
  .describe('Open a preview of the completed task at this exact run and epoch.');

export const terminalPreviewResultSchema = terminalPreviewParamsSchema
  .extend({ preview: previewStartResultSchema })
  .describe('A host-owned application preview and the task run that opened it.');

export const terminalStatusParamsSchema = z
  .strictObject({ workerId })
  .describe('Read one saved task without mutating it.');
export const terminalOperationParamsSchema = z
  .strictObject({ requestId: operationId })
  .describe('Read a durable operation receipt without repeating its effects.');

export const terminalOperationSchema = z
  .strictObject({
    requestId: operationId,
    kind: z.enum(['start', 'stop', 'resume']).describe('The requested terminal operation.'),
    state: z
      .enum(['preparing', 'queued', 'claimed', 'succeeded', 'failed', 'interrupted'])
      .describe('Durable dispatch state. Claimed or interrupted requests must never be blindly replayed.'),
    workerId: workerId.optional().describe('The task created or selected before browser dispatch.'),
    expectedRun: taskBoundarySchema.optional().describe('The original task execution boundary.'),
    createdAt: timestamp,
    updatedAt: timestamp,
    error: z
      .string()
      .max(2000)
      .optional()
      .describe('A concrete failure or uncertain outcome; no claim that external effects were undone.'),
  })
  .describe(
    'A durable operation receipt; succeeded means dispatch was acknowledged, not that the task completed.',
  );

export const terminalTaskSchema = z
  .strictObject({
    id: workerId,
    projectId: z.string().min(1).describe('The owning registered project.'),
    projectPath: z.string().min(1).max(2000).describe('The registered project root.'),
    name: z.string().describe('Task display name.'),
    goal: z.string().describe('The saved task goal.'),
    state: workerStateSchema,
    expectedRun: taskBoundarySchema,
    completion: completionRecordSchema.optional().describe('Host-recorded completion evidence when present.'),
    pendingApproval: z.boolean().describe('Whether the task is waiting for its ordinary command approval.'),
    error: z.string().max(4000).optional().describe('The latest task error, bounded for terminal output.'),
  })
  .describe('A terminal-safe task summary without prompts, source observations or approval tokens.');

export const terminalStatusSchema = z
  .strictObject({
    worker: terminalTaskSchema,
    browserConnected: z
      .boolean()
      .describe('Whether the matching browser relay has polled within the last five seconds.'),
    progress: bridgeProgressSummarySchema
      .optional()
      .describe('Latest saved chat progress for this exact task.'),
    operation: terminalOperationSchema.optional().describe('Most recent terminal operation for this task.'),
    events: z
      .array(
        z.strictObject({
          id: z.number().int().nonnegative().describe('Monotonic saved event identifier.'),
          time: timestamp,
          kind: z.string().max(100).describe('The event category.'),
          message: z
            .string()
            .max(500)
            .describe('A bounded event description, not full source or model output.'),
        }),
      )
      .max(20)
      .describe('Up to twenty recent task events in chronological order.'),
  })
  .describe('Fresh task status read from the one active host owner.');

const relayVersion = z.string().min(1).max(100).describe('The application version reported by this process.');
const versionMismatchSchema = z.strictObject({
  extensionVersion: relayVersion.describe('The running Chrome extension version that attempted to connect.'),
  hostVersion: relayVersion.describe('The version required by the running native host.'),
});

export function terminalVersionMismatchMessage(mismatch: z.infer<typeof versionMismatchSchema>): string {
  return `The Chrome extension reports Miter ${mismatch.extensionVersion}. The local helper requires ${mismatch.hostVersion}. Reload Miter in chrome://extensions in the Chrome profile you use for tasks.`;
}

export const terminalListSchema = z
  .strictObject({
    browserConnected: z.boolean().describe('Whether the browser relay is currently available.'),
    browserVersionMismatch: versionMismatchSchema
      .optional()
      .describe(
        'Most recent incompatible extension in the last minute, when no matching relay is connected.',
      ),
    tasks: z
      .array(terminalTaskSchema.omit({ goal: true, completion: true, error: true }))
      .max(100)
      .describe(
        'The latest hundred task identities, newest first; use status for the full goal and evidence.',
      ),
  })
  .describe('Recent task summaries without opening a second database owner.');

export const terminalDescriptorSchema = z
  .strictObject({
    version: z.literal(1).describe('Private terminal transport format version.'),
    pid: z.number().int().positive().describe('The host process that owns this endpoint.'),
    socketPath: z
      .string()
      .min(1)
      .max(1000)
      .describe('The absolute Unix socket path inside the private endpoint directory.'),
    token: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('A local bearer token stored only in an owner-readable descriptor.'),
  })
  .describe(
    'Private endpoint discovery; clients must validate ownership, permissions and file identities before connecting.',
  );

const requestBase = { version: z.literal(1), id: operationId, token: terminalDescriptorSchema.shape.token };
export const terminalControlRequestSchema = z
  .discriminatedUnion('method', [
    z.strictObject({ ...requestBase, method: z.literal('start'), params: terminalStartParamsSchema }),
    z.strictObject({ ...requestBase, method: z.literal('stop'), params: terminalStopParamsSchema }),
    z.strictObject({ ...requestBase, method: z.literal('resume'), params: terminalResumeParamsSchema }),
    z.strictObject({ ...requestBase, method: z.literal('preview'), params: terminalPreviewParamsSchema }),
    z.strictObject({ ...requestBase, method: z.literal('status'), params: terminalStatusParamsSchema }),
    z.strictObject({ ...requestBase, method: z.literal('operation'), params: terminalOperationParamsSchema }),
    z.strictObject({ ...requestBase, method: z.literal('list'), params: z.strictObject({}) }),
  ])
  .describe('One authenticated bounded local terminal request.');

export const terminalControlResponseSchema = z
  .discriminatedUnion('ok', [
    z.strictObject({
      version: z.literal(1),
      id: operationId,
      ok: z.literal(true),
      result: z.union([
        terminalOperationSchema,
        terminalStatusSchema,
        terminalListSchema,
        terminalPreviewResultSchema,
      ]),
    }),
    z.strictObject({
      version: z.literal(1),
      id: operationId,
      ok: z.literal(false),
      error: z.string().min(1).max(2000),
    }),
  ])
  .describe('A checked response bound to the exact transport request identifier.');

const commandBase = {
  requestId: operationId,
  workerId,
  expectedRun: taskBoundarySchema,
  claimToken: operationId,
};
export const terminalCommandSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...commandBase,
      kind: z.literal('start'),
      localPreview: z
        .literal(true)
        .optional()
        .describe('Launch the existing project locally without starting a coding conversation.'),
      consent: z.literal(true),
      maxTurns: terminalStartParamsSchema.shape.maxTurns,
      maxMinutes: terminalStartParamsSchema.shape.maxMinutes,
    }),
    z.strictObject({ ...commandBase, kind: z.literal('stop') }),
    z.strictObject({ ...commandBase, kind: z.literal('resume') }),
  ])
  .describe('One durably claimed browser command bound to its original task run.');

export const terminalClaimParamsSchema = z
  .strictObject({
    sessionId: operationId,
    version: relayVersion.describe('The running extension version; it must match this host.'),
    available: z
      .boolean()
      .describe('Whether the relay is ready for another command; false still refreshes its heartbeat.'),
  })
  .describe('Poll from one background relay instance; each browser restart gets a new session identifier.');
export const terminalClaimResultSchema = z
  .strictObject({ command: terminalCommandSchema.nullable() })
  .describe(
    'At most one command; null means no unclaimed work. Claims are durable before this response is sent.',
  );
export const terminalCompleteParamsSchema = z
  .strictObject({
    sessionId: operationId,
    requestId: operationId,
    claimToken: operationId,
    ok: z.boolean().describe('Whether the browser controller acknowledged this operation.'),
    error: z.string().max(2000).optional().describe('The bounded browser error when acknowledgement failed.'),
  })
  .describe('A browser acknowledgement for the exact durable claim; it does not mean the task completed.');
export const terminalCompleteResultSchema = z
  .strictObject({ recorded: z.literal(true) })
  .describe('The exact browser acknowledgement has been saved.');

export type TerminalStartParams = z.infer<typeof terminalStartParamsSchema>;
export type TerminalStopParams = z.infer<typeof terminalStopParamsSchema>;
export type TerminalPreviewParams = z.infer<typeof terminalPreviewParamsSchema>;
export type TerminalResumeParams = z.infer<typeof terminalResumeParamsSchema>;
export type TerminalOperation = z.infer<typeof terminalOperationSchema>;
export type TerminalStatus = z.infer<typeof terminalStatusSchema>;
export type TerminalTask = z.infer<typeof terminalTaskSchema>;
export type TerminalDescriptor = z.infer<typeof terminalDescriptorSchema>;
export type TerminalControlRequest = z.infer<typeof terminalControlRequestSchema>;
export type TerminalControlResponse = z.infer<typeof terminalControlResponseSchema>;
export type TerminalCommand = z.infer<typeof terminalCommandSchema>;
export type TerminalList = z.infer<typeof terminalListSchema>;
export type TerminalClaimParams = z.infer<typeof terminalClaimParamsSchema>;
export type TerminalCompleteParams = z.infer<typeof terminalCompleteParamsSchema>;
