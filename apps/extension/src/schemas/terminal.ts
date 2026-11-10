import { z } from 'zod';
import { parseRpcResult, type RpcResult } from '../../../../packages/protocol/src/rpc.js';
import {
  MAX_INPUT,
  TerminalIdSchema,
  TerminalInfoSchema,
  TerminalReadSchema,
  TerminalWrittenSchema,
  TerminalResizedSchema,
  TerminalClosedSchema,
  TerminalReleasedSchema,
} from '../../../../packages/terminal/src/protocol.js';
import { identifierSchema } from './primitives.js';

export {
  TerminalWrittenSchema as terminalWrittenSchema,
  TerminalResizedSchema as terminalResizedSchema,
  TerminalClosedSchema as terminalClosedSchema,
  TerminalReleasedSchema as terminalReleasedSchema,
  type TerminalWritten,
  type TerminalResized,
  type TerminalClosed,
  type TerminalReleased,
} from '../../../../packages/terminal/src/protocol.js';

const listParametersSchema = z
  .strictObject({ projectId: TerminalIdSchema.optional().describe('Optional project filter.') })
  .describe('A human terminal listing with no caller-supplied ownership token.');
const createParametersSchema = z
  .strictObject({
    projectId: TerminalIdSchema.describe('The project that will own the shell.'),
    workerId: TerminalIdSchema.optional().describe('The optional associated task.'),
    cols: TerminalInfoSchema.shape.cols,
    rows: TerminalInfoSchema.shape.rows,
    confirm: z.literal(true).describe('Explicit human authorization to start a real shell.'),
  })
  .describe('An explicitly confirmed terminal creation without caller-supplied ownership.');
const sessionParametersSchema = z
  .strictObject({ sessionId: TerminalIdSchema.describe('The exact session owned by this terminal view.') })
  .describe('A terminal session selected by the authenticated view.');
const readParametersSchema = sessionParametersSchema
  .extend({
    after: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .describe('Last consumed output sequence.'),
  })
  .describe('A bounded read after the last acknowledged output frame.');
const writeParametersSchema = sessionParametersSchema
  .extend({ data: z.string().max(MAX_INPUT).describe('Exact human terminal input, never replayed.') })
  .describe('Literal human input for the view-owned shell.');
const resizeParametersSchema = sessionParametersSchema
  .extend({ cols: TerminalInfoSchema.shape.cols, rows: TerminalInfoSchema.shape.rows })
  .describe('New dimensions for the view-owned shell.');
const closeParametersSchema = sessionParametersSchema
  .extend({ confirm: z.literal(true).describe('Explicit human authorization to close the shell.') })
  .describe('An explicitly confirmed termination of the selected shell.');

export const terminalRpcRegistry = Object.freeze({
  'terminal.list': {
    params: listParametersSchema,
    result: z.array(TerminalInfoSchema).describe('The complete local shell sessions visible to the view.'),
    mutation: false,
  },
  'terminal.create': { params: createParametersSchema, result: TerminalInfoSchema, mutation: true },
  'terminal.attach': { params: sessionParametersSchema, result: TerminalInfoSchema, mutation: true },
  'terminal.read': { params: readParametersSchema, result: TerminalReadSchema, mutation: false },
  'terminal.write': { params: writeParametersSchema, result: TerminalWrittenSchema, mutation: true },
  'terminal.resize': { params: resizeParametersSchema, result: TerminalResizedSchema, mutation: true },
  'terminal.close': { params: closeParametersSchema, result: TerminalClosedSchema, mutation: true },
  'terminal.release': { params: sessionParametersSchema, result: TerminalReleasedSchema, mutation: true },
});

export type TerminalRpcMethod = keyof typeof terminalRpcRegistry;
export type TerminalRpcResult<Method extends TerminalRpcMethod> = RpcResult<
  typeof terminalRpcRegistry,
  Method
>;

const ownership = {
  clientId: TerminalIdSchema.describe('The ownership token assigned by the authenticated port.'),
};
export const nativeTerminalRpcRegistry = Object.freeze({
  'terminal.list': {
    ...terminalRpcRegistry['terminal.list'],
    params: listParametersSchema
      .extend(ownership)
      .describe('A terminal listing scoped to its authenticated native client.'),
  },
  'terminal.create': {
    ...terminalRpcRegistry['terminal.create'],
    params: createParametersSchema
      .extend(ownership)
      .describe('An explicitly authorized shell owned by its authenticated native client.'),
  },
  'terminal.attach': {
    ...terminalRpcRegistry['terminal.attach'],
    params: sessionParametersSchema
      .extend(ownership)
      .describe('Attach one session to its authenticated native client.'),
  },
  'terminal.read': {
    ...terminalRpcRegistry['terminal.read'],
    params: readParametersSchema
      .extend(ownership)
      .describe('A sequence-bound output read by the authenticated native client.'),
  },
  'terminal.write': {
    ...terminalRpcRegistry['terminal.write'],
    params: writeParametersSchema
      .extend(ownership)
      .describe('Exact human input for the authenticated native client, without replay.'),
  },
  'terminal.resize': {
    ...terminalRpcRegistry['terminal.resize'],
    params: resizeParametersSchema
      .extend(ownership)
      .describe('Shell dimensions set by the authenticated native client.'),
  },
  'terminal.close': {
    ...terminalRpcRegistry['terminal.close'],
    params: closeParametersSchema
      .extend(ownership)
      .describe('Explicitly close the shell owned by the authenticated native client.'),
  },
  'terminal.release': {
    ...terminalRpcRegistry['terminal.release'],
    params: sessionParametersSchema
      .extend(ownership)
      .describe('Release one shell without replay or a change of native ownership.'),
  },
  'terminal.disconnect': {
    params: z.strictObject(ownership).describe('Release every session owned by this authenticated port.'),
    result: TerminalReleasedSchema,
    mutation: true,
  },
});

export const terminalRequestSchema = z
  .discriminatedUnion('method', [
    z.object({ id: identifierSchema, method: z.literal('terminal.list'), params: listParametersSchema }),
    z.object({ id: identifierSchema, method: z.literal('terminal.create'), params: createParametersSchema }),
    z.object({ id: identifierSchema, method: z.literal('terminal.attach'), params: sessionParametersSchema }),
    z.object({ id: identifierSchema, method: z.literal('terminal.read'), params: readParametersSchema }),
    z.object({ id: identifierSchema, method: z.literal('terminal.write'), params: writeParametersSchema }),
    z.object({ id: identifierSchema, method: z.literal('terminal.resize'), params: resizeParametersSchema }),
    z.object({ id: identifierSchema, method: z.literal('terminal.close'), params: closeParametersSchema }),
    z.object({
      id: identifierSchema,
      method: z.literal('terminal.release'),
      params: sessionParametersSchema,
    }),
  ])
  .describe('A validated human terminal operation with no caller-supplied ownership token.');

export type TerminalRequest = z.infer<typeof terminalRequestSchema>;

export function parseTerminalResult(method: string, result: unknown): unknown {
  return parseRpcResult(terminalRpcRegistry, method, result);
}
