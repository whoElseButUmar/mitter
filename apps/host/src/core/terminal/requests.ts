import { z } from 'zod';
import {
  TerminalIdSchema,
  TerminalDimensionSchema,
  TerminalInfoSchema,
  MAX_INPUT,
} from '../../../../../packages/terminal/src/protocol.js';
const clientSchema = z
  .strictObject({
    clientId: TerminalIdSchema.describe('The view requesting exclusive terminal control.'),
  })
  .describe('The terminal view identity checked before a human-operated request.');
const sessionSchema = clientSchema
  .extend({
    sessionId: TerminalIdSchema.describe('The exact local shell session targeted by the view.'),
  })
  .describe('The requesting view and exact terminal session.');
const sizeSchema = {
  cols: TerminalInfoSchema.shape.cols,
  rows: TerminalInfoSchema.shape.rows,
};

export const terminalRequestSchema = z
  .discriminatedUnion('method', [
    z.object({
      method: z.literal('terminal.list').describe('List locally retained shell sessions.'),
      params: clientSchema.extend({
        projectId: TerminalIdSchema.optional().describe('The project filter, absent to list all sessions.'),
      }),
    }),
    z.object({
      method: z.literal('terminal.create').describe('Start one explicitly confirmed local shell.'),
      params: clientSchema.extend({
        projectId: TerminalIdSchema.describe('The registered project that will own the shell.'),
        workerId: TerminalIdSchema.optional().describe(
          'The task whose worktree to use, absent for the project root.',
        ),
        ...sizeSchema,
        confirm: z
          .literal(true, {
            error: 'Starting a real local shell requires your confirmation.',
          })
          .describe('Explicit human authorization to start a real local shell.'),
      }),
    }),
    z.object({
      method: z.literal('terminal.attach').describe('Claim exclusive control of an existing session.'),
      params: sessionSchema,
    }),
    z.object({
      method: z.literal('terminal.read').describe('Read bounded output after an acknowledged sequence.'),
      params: sessionSchema.extend({
        after: TerminalDimensionSchema.min(0)
          .max(Number.MAX_SAFE_INTEGER)
          .describe('The last acknowledged output sequence number.'),
      }),
    }),
    z.object({
      method: z.literal('terminal.write').describe('Send literal human input to an owned shell.'),
      params: sessionSchema.extend({
        data: z
          .string()
          .max(MAX_INPUT)
          .describe('Literal human shell input, including controls, within the input size bound.'),
      }),
    }),
    z.object({
      method: z
        .literal('terminal.resize')
        .describe('Resize an owned terminal within the supported dimensions.'),
      params: sessionSchema.extend(sizeSchema),
    }),
    z.object({
      method: z.literal('terminal.close').describe('Terminate an owned shell after explicit confirmation.'),
      params: sessionSchema.extend({
        confirm: z
          .literal(true, {
            error: 'Closing a shell requires confirmation.',
          })
          .describe('Explicit human authorization to terminate this shell.'),
      }),
    }),
    z.object({
      method: z.literal('terminal.release').describe('Release view ownership without terminating the shell.'),
      params: sessionSchema,
    }),
    z.object({
      method: z.literal('terminal.disconnect').describe('Release every session owned by this view.'),
      params: clientSchema,
    }),
  ])
  .describe(
    'Strict human-operated terminal requests; client ownership is checked ' + 'by the session manager.',
  );

export type TerminalRequest = z.infer<typeof terminalRequestSchema>;
