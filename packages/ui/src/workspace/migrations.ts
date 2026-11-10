import { z } from 'zod';
import {
  ClosedTabSchema,
  NavigationStateSchema,
  WorkspaceStateSchema,
  projectDictionarySchema,
} from './schemas.js';

const SavedStringSchema = z
  .string()
  .optional()
  .catch(undefined)
  .describe('A saved identifier; malformed or missing values are omitted during restoration.');
const SavedStringsSchema = z
  .array(SavedStringSchema)
  .catch([])
  .transform((entries) => [...new Set(entries.filter((entry) => entry !== undefined))])
  .describe('Saved identifiers with malformed entries and duplicates removed, preserving their order.');

const SavedTaskSelectionsSchema = projectDictionarySchema(SavedStringSchema)
  .catch({})
  .transform((entries) => {
    const selections: Record<string, string> = {};
    Object.setPrototypeOf(selections, null);

    for (const [projectId, taskId] of Object.entries(entries)) {
      if (taskId !== undefined) {
        selections[projectId] = taskId;
      }
    }

    return selections;
  })
  .describe('Saved task selections; malformed values are removed before checking project ownership.');

export const SavedNavigationSchema = NavigationStateSchema.extend({
  projectId: NavigationStateSchema.shape.projectId
    .catch('')
    .describe('The saved selected project, or an empty string if corrupt.'),
  taskByProject: SavedTaskSelectionsSchema,
}).describe('Version-one navigation migration with independent defaults for corrupt selection fields.');

const SavedClosedTabSchema = ClosedTabSchema.extend({
  wasSelected: z
    .preprocess((value) => value === true, z.boolean())
    .describe('Legacy selection flag; only a saved boolean true restores selection.'),
}).describe('A saved closed tab with its legacy selection flag migrated explicitly.');

export const SavedWorkspaceStateSchema = WorkspaceStateSchema.extend({
  revision: WorkspaceStateSchema.shape.revision
    .catch(0)
    .describe('The saved nonnegative revision, or zero if corrupt.'),
  projectId: WorkspaceStateSchema.shape.projectId
    .catch('')
    .describe('The saved selected project, or an empty string if corrupt.'),
  taskByProject: SavedTaskSelectionsSchema,
  openProjects: SavedStringsSchema,
  openTasks: projectDictionarySchema(SavedStringsSchema)
    .catch({})
    .describe('Saved open task rows with invalid lists replaced by empty rows.'),
  knownProjects: SavedStringsSchema,
  knownTasks: SavedStringsSchema,
  recentlyClosed: z
    .array(SavedClosedTabSchema.optional().catch(undefined))
    .catch([])
    .transform((entries) => entries.filter((entry) => entry !== undefined))
    .describe('Valid saved closed tabs; restoration separately deduplicates and bounds history.'),
}).describe(
  'Version-two workspace migration that salvages valid fields without granting execution authority.',
);

export const SavedWorkspaceVersionSchema = z
  .object({ version: z.number().describe('The persisted workspace format number.') })
  .describe('A version probe that prevents overwriting workspace data written by a newer application.');

export type SavedNavigation = z.infer<typeof SavedNavigationSchema>;
export type SavedWorkspaceState = z.infer<typeof SavedWorkspaceStateSchema>;
export type SavedWorkspaceVersion = z.infer<typeof SavedWorkspaceVersionSchema>;
