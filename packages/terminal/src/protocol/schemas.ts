import { z } from 'zod';

export const TerminalIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,100}$/)
  .describe('An identifier with 1 to 100 letters, numbers, underscores, or hyphens.');

export const TerminalMethodSchema = z
  .enum([
    'terminal.list',
    'terminal.create',
    'terminal.attach',
    'terminal.read',
    'terminal.write',
    'terminal.resize',
    'terminal.close',
    'terminal.release',
    'terminal.disconnect',
  ])
  .describe('An operation available through the human-operated terminal channel.');

export const TerminalDimensionSchema = z
  .number()
  .int()
  .describe('A whole-number size or output position, checked against the allowed range.');

export const TerminalInfoSchema = z
  .object({
    id: TerminalIdSchema.describe('The terminal session identifier.'),
    projectId: TerminalIdSchema.describe('The project that owns this shell.'),
    workerId: TerminalIdSchema.optional().describe(
      'The task associated with this shell. Absent for a project-only shell.',
    ),
    title: z.string().describe('The shell name shown in the terminal tab.'),
    cwd: z.string().describe('The folder where the shell started.'),
    shell: z.string().describe('The path to the shell program.'),
    pid: z.number().int().describe('The operating system process identifier of the shell.'),
    cols: TerminalDimensionSchema.min(10)
      .max(500)
      .describe('Terminal width in character columns, from 10 to 500.'),
    rows: TerminalDimensionSchema.min(2).max(300).describe('Terminal height in text rows, from 2 to 300.'),
    createdAt: z.number().describe('When the shell started, in milliseconds since January 1, 1970.'),
    exited: z.boolean().describe('Whether the shell process has ended.'),
    exitCode: z.number().int().optional().describe('The shell exit status. Absent until the shell ends.'),
    owned: z.boolean().describe('Whether the requesting view controls this terminal.'),
    occupied: z.boolean().describe('Whether another view controls this terminal.'),
    paused: z.boolean().describe('Whether output is paused while the view catches up.'),
  })
  .describe('The current state of a local shell session.');

export const TerminalFrameSchema = z
  .object({
    seq: z.number().int().nonnegative().describe('The output chunk number, used to read chunks in order.'),
    data: z.string().describe('Shell output in this chunk, including terminal control characters.'),
  })
  .describe('One numbered chunk of shell output.');

export const TerminalReadSchema = z
  .object({
    frames: z.array(TerminalFrameSchema).describe('Output chunks after the last acknowledged chunk.'),
    exited: TerminalInfoSchema.shape.exited,
    exitCode: TerminalInfoSchema.shape.exitCode,
    reset: z.boolean().describe('Whether earlier output was discarded and the display must reset.'),
    paused: TerminalInfoSchema.shape.paused,
  })
  .describe('The output and shell state returned by a terminal read.');

export const TerminalWrittenSchema = z
  .strictObject({ written: z.literal(true).describe('The exact human input was delivered once.') })
  .describe('Acknowledgement of terminal input delivery, without replay.');
export const TerminalResizedSchema = z
  .strictObject({ resized: z.literal(true).describe('The owned shell dimensions were updated.') })
  .describe('Acknowledgement of a terminal resize.');
export const TerminalClosedSchema = z
  .strictObject({ closed: z.literal(true).describe('The explicitly selected shell was closed.') })
  .describe('Acknowledgement of an explicitly confirmed shell termination.');
export const TerminalReleasedSchema = z
  .strictObject({ released: z.literal(true).describe('The view released its shell ownership.') })
  .describe('Acknowledgement of releasing terminal ownership without closing the shell.');

export type TerminalWritten = z.infer<typeof TerminalWrittenSchema>;
export type TerminalResized = z.infer<typeof TerminalResizedSchema>;
export type TerminalClosed = z.infer<typeof TerminalClosedSchema>;
export type TerminalReleased = z.infer<typeof TerminalReleasedSchema>;
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;
export type TerminalFrame = z.infer<typeof TerminalFrameSchema>;
export type TerminalRead = z.infer<typeof TerminalReadSchema>;
