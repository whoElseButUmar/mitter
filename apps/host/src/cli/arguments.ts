import path from 'node:path';
import { z } from 'zod';
import { terminalStartParamsSchema } from '../../../../packages/protocol/src/terminal-control.js';

const identifier = z.string().min(1).max(200).describe('The exact saved task identifier.');
const output = z.boolean().describe('Whether to print newline-delimited JSON instead of readable text.');
const requestId = z
  .string()
  .uuid()
  .optional()
  .describe('A stable request identifier for exact retry or receipt lookup.');

export const terminalArgumentsSchema = z
  .discriminatedUnion('command', [
    z.strictObject({ command: z.literal('help').describe('Show command usage.') }),
    z.strictObject({ command: z.literal('version').describe('Show the installed terminal version.') }),
    z
      .strictObject({
        command: z.literal('start').describe('Create and start a task through the connected extension.'),
        projectPath: z
          .string()
          .min(1)
          .max(2000)
          .refine(path.isAbsolute, 'Use an absolute project path.')
          .describe('The absolute project folder.'),
        createProject: z.boolean().describe('Explicit permission to create a missing project folder.'),
        name: z.string().trim().min(1).max(60).optional().describe('Optional display name for the task.'),
        goal: terminalStartParamsSchema.shape.goal.optional(),
        goalFile: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe('A UTF-8 file containing the literal task instruction.'),
        maxTurns: z.number().int().min(1).max(20).describe('Maximum automatic model turns for this run.'),
        maxMinutes: z.number().int().min(1).max(60).describe('Maximum active run time in minutes.'),
        watch: z.boolean().describe('Whether to monitor this task after its start is accepted.'),
        json: output,
        requestId,
      })
      .refine(
        (value) => (value.goal === undefined) !== (value.goalFile === undefined),
        'Provide exactly one of --goal and --goal-file.',
      ),
    z.strictObject({
      command: z.literal('status').describe('Read one task.'),
      workerId: identifier,
      json: output,
    }),
    z.strictObject({
      command: z.literal('preview').describe('Serve a completed web app and print its local preview URL.'),
      workerId: identifier,
      json: output,
    }),
    z.strictObject({
      command: z.literal('watch').describe('Monitor one task without taking ownership of its execution.'),
      workerId: identifier,
      json: output,
    }),
    z.strictObject({ command: z.literal('list').describe('List saved tasks.'), json: output }),
    z.strictObject({
      command: z.literal('stop').describe('Stop the reviewed task run.'),
      workerId: identifier,
      json: output,
      requestId,
    }),
    z.strictObject({
      command: z.literal('resume').describe('Resume the saved chat with its remaining task budget.'),
      workerId: identifier,
      watch: z.boolean().describe('Whether to monitor the resumed task after admission.'),
      json: output,
      requestId,
    }),
    z.strictObject({
      command: z.literal('operation').describe('Read a saved terminal operation receipt.'),
      requestId: z.string().uuid().describe('The original mutation request identifier.'),
      json: output,
    }),
    z.strictObject({
      command: z.literal('legacy').describe('Run an existing offline maintenance command.'),
      operation: z
        .enum(['state', 'request', 'import', 'run', 'prompt', 'report'])
        .describe('The existing maintenance command.'),
      args: z
        .array(z.string())
        .max(2)
        .describe('Exactly the positional arguments needed by that maintenance command.'),
      portable: z.boolean().describe('Use the existing portable Node SQLite mode for offline maintenance.'),
    }),
  ])
  .describe('Strictly parsed terminal arguments; parsing does not start or modify a task.');

export type TerminalArguments = z.infer<typeof terminalArgumentsSchema>;

function parseInteger(value: string | undefined, fallback: number, option: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(option + ' requires a whole number.');
  }
  return Number(value);
}

export function parseTerminalArguments(input: readonly string[]): TerminalArguments {
  let args = [...input];
  if (args[0] === 'task') {
    args = args.slice(1);
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === 'version' || args[0] === '-v')) {
    return { command: 'version' };
  }
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    if (args.length > 1) {
      throw new Error('Help does not accept additional arguments.');
    }
    return { command: 'help' };
  }
  if (
    args.length === 2 &&
    args[1] === '--help' &&
    ['start', 'status', 'preview', 'watch', 'list', 'stop', 'resume', 'operation'].includes(args[0] ?? '')
  ) {
    return { command: 'help' };
  }

  const portable = args.includes('--portable');
  if (portable) {
    if (args.filter((value) => value === '--portable').length !== 1) {
      throw new Error('Do not repeat --portable.');
    }
    args = args.filter((value) => value !== '--portable');
  }
  const command = args.shift();
  if (!command) {
    throw new Error('Provide a command. Run miter help for usage.');
  }
  const legacyCounts = new Map([
    ['state', 0],
    ['request', 2],
    ['import', 2],
    ['run', 1],
    ['prompt', 1],
    ['report', 1],
  ]);
  const legacyCount = legacyCounts.get(command);
  if (legacyCount !== undefined) {
    if (command === 'request' && args.length === 1) {
      args.push('{}');
    }
    if (args.length !== legacyCount) {
      throw new Error(command + ' requires exactly ' + legacyCount + ' argument(s).');
    }
    return terminalArgumentsSchema.parse({ command: 'legacy', operation: command, args, portable });
  }
  if (portable) {
    throw new Error(
      '--portable applies only to offline maintenance commands. Normal task commands use the running host.',
    );
  }
  if (!['start', 'status', 'preview', 'watch', 'list', 'stop', 'resume', 'operation'].includes(command)) {
    throw new Error('Unknown command: ' + command + '. Run miter help for usage.');
  }

  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  const allowedValues = new Set<string>();
  const allowedFlags = new Set(['--json']);
  if (command === 'start') {
    for (const name of [
      '--project',
      '--goal',
      '--goal-file',
      '--name',
      '--max-turns',
      '--max-minutes',
      '--request-id',
    ]) {
      allowedValues.add(name);
    }
    allowedFlags.add('--watch');
    allowedFlags.add('--create');
  }
  if (command === 'stop' || command === 'resume') {
    allowedValues.add('--request-id');
  }
  if (command === 'resume') {
    allowedFlags.add('--watch');
  }
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === undefined) {
      break;
    }
    if (!argument.startsWith('-')) {
      positionals.push(argument);
      continue;
    }
    if (values.has(argument) || flags.has(argument)) {
      throw new Error('Do not repeat ' + argument + '.');
    }
    if (allowedFlags.has(argument)) {
      flags.add(argument);
      continue;
    }
    if (!allowedValues.has(argument)) {
      throw new Error('Unknown option for ' + command + ': ' + argument + '.');
    }
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) {
      throw new Error('Provide a value after ' + argument + '.');
    }
    values.set(argument, value);
  }
  const json = flags.has('--json');
  try {
    if (command === 'start') {
      if (positionals.length !== 0) {
        throw new Error('Use --goal or --goal-file for the task instruction.');
      }
      return terminalArgumentsSchema.parse({
        command,
        projectPath: values.get('--project'),
        createProject: flags.has('--create'),
        name: values.get('--name'),
        goal: values.get('--goal'),
        goalFile: values.get('--goal-file'),
        maxTurns: parseInteger(values.get('--max-turns'), 20, '--max-turns'),
        maxMinutes: parseInteger(values.get('--max-minutes'), 60, '--max-minutes'),
        watch: flags.has('--watch'),
        json,
        requestId: values.get('--request-id'),
      });
    }
    if (command === 'list') {
      if (positionals.length !== 0) {
        throw new Error('List does not accept a task identifier.');
      }
      return { command, json };
    }
    if (positionals.length !== 1) {
      throw new Error(command + ' requires exactly one identifier.');
    }
    if (command === 'operation') {
      return terminalArgumentsSchema.parse({ command, requestId: positionals[0], json });
    }
    if (command === 'stop') {
      return terminalArgumentsSchema.parse({
        command,
        workerId: positionals[0],
        json,
        requestId: values.get('--request-id'),
      });
    }
    if (command === 'resume') {
      return terminalArgumentsSchema.parse({
        command,
        workerId: positionals[0],
        watch: flags.has('--watch'),
        json,
        requestId: values.get('--request-id'),
      });
    }
    return terminalArgumentsSchema.parse({ command, workerId: positionals[0], json });
  } catch (error) {
    if (!(error instanceof z.ZodError)) {
      throw error;
    }
    throw new Error('Invalid ' + command + ' arguments. Use miter ' + command + ' --help for usage.', {
      cause: error,
    });
  }
}

export const terminalHelp = `Miter — terminal task control

  miter start --project /absolute/folder --goal "Build an app" [--watch]
  miter start --project /absolute/new-folder --create --goal-file brief.txt
  miter status TASK_ID [--json]
  miter preview TASK_ID [--json]
  miter watch TASK_ID [--json]
  miter list [--json]
  miter stop TASK_ID [--request-id UUID] [--json]
  miter resume TASK_ID [--watch] [--request-id UUID] [--json]
  miter operation REQUEST_ID [--json]
  miter --version

Start options:
  --name NAME          Task display name
  --max-turns N        Initial automatic turn limit (1–20; default 20)
  --max-minutes N      Active time limit (1–60; default 60)
  --request-id UUID    Stable identity for retrying the exact same request
  --watch             Monitor after start; Ctrl+C leaves the task running
  --json              Print newline-delimited JSON

Keep Miter enabled in Chrome. A framework launch such as "Start the dev server
and open the preview" runs locally. For coding tasks, sign in to ChatGPT and
grant its site permission. Starting a ChatGPT task authorizes sending the goal
and relevant project files to that site. Task commands use the running host.
Approval and run budgets still apply. An interrupted watch does not stop its task.
Resume preserves the saved conversation, receipts and remaining budget. It does
not extend limits or revive a task plan retired by Stop.
If Chrome or the extension restarts while waiting for a confirmed reply, Miter
reconnects to the saved conversation. For an expired watch, use miter resume TASK_ID --watch.
Command approvals still need review in Miter.

Offline maintenance (close Miter's browser connection first):
  state | request METHOD JSON | import TASK_ID FILE | run TASK_ID
  prompt TASK_ID | report TASK_ID
  --portable uses Node SQLite for these maintenance commands only.
`;
