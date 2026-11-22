import { z } from 'zod';
import { identifierSchema, textSchema } from '../schemas/primitives.js';
import { projectParamsSchema } from './requests.js';

export const maxProjectWorkflows = 64;

export const workflowProjectParamsSchema = projectParamsSchema
  .strict()
  .describe('The registered project that owns these browser workflows.');

export const workflowTargetParamsSchema = workflowProjectParamsSchema
  .extend({ id: identifierSchema('saved workflow ID') })
  .describe('One saved workflow belonging to the selected project.');

const name = textSchema('workflow name', 80);
const verifyAfterRestart = z
  .boolean()
  .describe('Check the recorded expectation again after a server restart.');

export const workflowSaveParamsSchema = workflowProjectParamsSchema
  .extend({ name, verifyAfterRestart })
  .describe('Name and save the active project recording.');

export const workflowSummarySchema = z
  .strictObject({
    id: identifierSchema('saved workflow ID'),
    name,
    verifyAfterRestart,
    lastResult: z
      .strictObject({
        ok: z.boolean().describe('Whether the most recent replay passed.'),
        detail: textSchema('replay result', 2000),
      })
      .optional()
      .describe('The outcome of the latest completed replay.'),
  })
  .describe('A saved browser workflow with its most recent replay result.');

export const workflowStateSchema = z
  .strictObject({
    recording: z.boolean().describe('Whether a browser recording is open for this project.'),
    workflows: z
      .array(workflowSummarySchema)
      .max(maxProjectWorkflows)
      .describe('Browser workflows saved for this project.'),
  })
  .describe('Current recording status and saved workflows, without captured input values.');

export type ProjectWorkflowState = z.infer<typeof workflowStateSchema>;
