import { z } from 'zod';
import { object, only, parseChecks, text } from '../../../../../packages/protocol/src/index.js';
import { parseProposalAction, proposalActionSchema } from '../../../../../packages/protocol/src/proposal.js';
import { parseSchema } from '../../../../../packages/protocol/src/helpers.js';

import { textSchema } from '../../../../../packages/protocol/src/schemas/primitives.js';
import {
  workerCreationSchema,
  optionalRpcFlagSchema,
  browsePathSchema,
  promptKindSchema,
  handoffTextSchema,
} from '../../../../../packages/protocol/src/rpc.js';
import type { WorkerCreation } from '../../../../../packages/protocol/src/rpc.js';
export { workerCreationSchema, promptKindSchema } from '../../../../../packages/protocol/src/rpc.js';
export type { WorkerCreation } from '../../../../../packages/protocol/src/rpc.js';
import { suggestedTaskName } from '../../../../../packages/protocol/src/task-brief.js';

import { validateRelative } from '../workspace.js';

export const localProposalSchema = z
  .strictObject({
    summary: textSchema('summary', 4000).describe(
      'The local model summary, with literal whitespace retained.',
    ),
    actions: z.array(proposalActionSchema).min(1).max(8).describe('One through eight proposed actions.'),
  })
  .describe('A local model proposal before read references are bound by the host.');

export type LocalProposal = z.infer<typeof localProposalSchema>;

// This is an internal staged parser, not a serialized proposal. Repeated-action
// bookkeeping must precede summary rejection without exposing an unchecked summary.
type LocalProposalDraft = {
  actions: LocalProposal['actions'];
  readSummary: () => LocalProposal['summary'];
};

export function parseLocalDraft(value: unknown): LocalProposalDraft {
  const proposal = object(value, 'model proposal');
  only(proposal, ['summary', 'actions']);

  const rawActions = proposal.actions;

  if (!Array.isArray(rawActions) || rawActions.length === 0 || rawActions.length > 8) {
    throw new Error('Model must propose 1–8 structured actions.');
  }

  const candidates: unknown[] = rawActions;
  const actions = candidates.map(parseProposalAction);
  const summary = proposal.summary;

  return {
    actions,
    readSummary: () => parseSchema(localProposalSchema.shape.summary, summary),
  };
}

export function parseLocalProposal(value: unknown): LocalProposal {
  const draft = parseLocalDraft(value);

  return { actions: draft.actions, summary: draft.readSummary() };
}

export function parseWorkerCreation(value: unknown): WorkerCreation {
  const params = object(value, 'params');
  const checks = parseChecks(params.checks ?? []);

  for (const check of checks) {
    if (check.type !== 'command') {
      validateRelative(check.path);
    }
  }

  const mode = workerCreationSchema.shape.mode.safeParse(params.mode);

  if (!mode.success) {
    throw new Error('Choose handoff or local mode.');
  }

  const goal = parseSchema(workerCreationSchema.shape.goal, params.goal).trim();
  let name: string;

  if (params.name === undefined || (typeof params.name === 'string' && !params.name.trim())) {
    name = suggestedTaskName(goal);
  } else {
    name = parseSchema(workerCreationSchema.shape.name, params.name).trim();
  }

  return {
    checks,
    mode: mode.data,
    goal,
    name,
    maxIterations: parseSchema(workerCreationSchema.shape.maxIterations, params.maxIterations ?? 8),
    maxMinutes: parseSchema(workerCreationSchema.shape.maxMinutes, params.maxMinutes ?? 15),
  };
}

export function parseHandoffText(value: unknown): string {
  return parseSchema(handoffTextSchema, value);
}

export function parseDisplayName(value: unknown, label: string): string {
  return text(value, label, 60).trim();
}

export function parseOptionalFlag(value: unknown, label: string): boolean | undefined {
  const parsed = optionalRpcFlagSchema(label).safeParse(value);

  if (!parsed.success) {
    throw new Error('Invalid ' + label + '. Use true or false.', { cause: parsed.error });
  }

  return parsed.data;
}

export function parseBrowsePath(value: unknown): string {
  const parsed = browsePathSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error('Invalid browse path. Use a relative project path.', { cause: parsed.error });
  }

  return parsed.data;
}

export function parsePromptKind(value: unknown): z.infer<typeof promptKindSchema> {
  const parsed = promptKindSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error('Choose bootstrap, review, fix or next for the prompt.', { cause: parsed.error });
  }

  return parsed.data;
}
