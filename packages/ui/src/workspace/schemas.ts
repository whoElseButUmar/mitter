import { z } from 'zod';

/** Zod records omit __proto__; project IDs must round-trip as own data properties. */
export function projectDictionarySchema<Schema extends z.ZodType>(valueSchema: Schema) {
  return z
    .preprocess(
      (value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return null;
        }

        const prototype: unknown = Object.getPrototypeOf(value);

        if (prototype !== null && prototype !== Object.prototype) {
          return null;
        }

        return new Map(Object.entries(value));
      },
      z.map(z.string().describe('Own project identifier, including built-in object names.'), valueSchema),
    )
    .transform((entries) => Object.fromEntries<z.infer<Schema>>(entries))
    .describe('A serialized project dictionary with every own key and value validated.');
}

export const NavigationProjectSchema = z
  .object({
    id: z.string().describe('Registered project identifier.'),
  })
  .describe('Project identity used only for UI navigation.');

export const NavigationTaskSchema = z
  .object({
    id: z.string().describe('Registered task identifier.'),
    projectId: z.string().describe('Project that owns the task.'),
  })
  .describe('Task identity used only for UI navigation.');

export const NavigationStateSchema = z
  .object({
    version: z.literal(1).describe('Legacy navigation storage version.'),
    projectId: z.string().describe('Selected project, or an empty string.'),
    taskByProject: projectDictionarySchema(z.string()).describe('Remembered task identifier per project.'),
  })
  .describe('Legacy UI selection; does not control worker execution.');

export const TabKindSchema = z.enum(['project', 'task']).describe('Workspace tab category.');

export const CatalogProjectSchema = NavigationProjectSchema.extend({
  name: z.string().optional().describe('Display name used in closed-tab history.'),
  root: z.string().optional().describe('Registered project directory.'),
}).describe('Registered project available to the workspace.');

export const CatalogTaskSchema = NavigationTaskSchema.extend({
  name: z.string().optional().describe('Task display name used in closed-tab history.'),
}).describe('Registered task available to the workspace.');

export const CatalogSchema = z
  .object({
    projects: z.array(CatalogProjectSchema).describe('Registered projects in display order.'),
    tasks: z.array(CatalogTaskSchema).describe('Registered tasks in display order.'),
  })
  .describe('Available records, independent of which tabs are open.');

export const ClosedTabSchema = z
  .object({
    key: z.string().describe('Unique history entry key.'),
    group: z.string().describe('Close operation group identifier.'),
    kind: TabKindSchema,
    id: z.string().describe('Closed project or task identifier.'),
    projectId: z.string().describe('Owning project identifier.'),
    label: z.string().describe('Retained display label when the record is unavailable.'),
    index: z.number().int().nonnegative().describe('Original position within its tab row.'),
    closedAt: z.number().min(0).max(8640000000000000).describe('Close time in epoch milliseconds.'),
    wasSelected: z.boolean().optional().describe('Whether this tab was selected before the close operation.'),
  })
  .describe('Reversible UI tab history; never a deleted project or task.');

export const WorkspaceStateSchema = z
  .object({
    version: z.literal(2).describe('Durable workspace storage version.'),
    revision: z.number().int().nonnegative().describe('Monotonic revision after a successful durable write.'),
    projectId: z.string().describe('Selected open project, or an empty string.'),
    taskByProject: projectDictionarySchema(z.string()).describe('Selected open task per project.'),
    openProjects: z.array(z.string()).describe('Open project tabs in order.'),
    openTasks: projectDictionarySchema(z.array(z.string())).describe('Open task tabs per project in order.'),
    knownProjects: z.array(z.string()).describe('Previously reconciled project identifiers.'),
    knownTasks: z.array(z.string()).describe('Previously reconciled task identifiers.'),
    recentlyClosed: z
      .array(ClosedTabSchema)
      .describe('Most recent closed tabs first, bounded during restoration.'),
  })
  .describe('Durable UI workspace; visibility never controls execution.');

const ActionIdentifierSchema = z.string().min(1).max(300).describe('Workspace action identifier.');
const projectId = ActionIdentifierSchema.optional().describe('Optional scope of a task tab operation.');
const tabAction = { kind: TabKindSchema, id: ActionIdentifierSchema };

export const WorkspaceActionSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('open'), ...tabAction }).describe('Open and select a tab.'),
    z.object({ type: z.literal('close'), ...tabAction }).describe('Close a tab without deleting its record.'),
    z.object({ type: z.literal('closeOthers'), ...tabAction }).describe('Close all other tabs in this row.'),
    z
      .object({ type: z.literal('closeRight'), ...tabAction })
      .describe('Close tabs to the right in this row.'),
    z
      .object({ type: z.literal('closeAll'), kind: TabKindSchema, projectId })
      .describe('Close a complete tab row.'),
    z
      .object({ type: z.literal('restore'), key: ActionIdentifierSchema })
      .describe('Restore one history entry.'),
    z
      .object({ type: z.literal('restoreLast'), kind: TabKindSchema.optional(), projectId })
      .describe('Restore the latest available tab within an optional scope.'),
    z
      .object({ type: z.literal('restoreGroup'), group: ActionIdentifierSchema })
      .describe('Restore a close group.'),
    z.object({ type: z.literal('clearHistory') }).describe('Clear UI history without deleting work.'),
  ])
  .describe('Validated workspace action accepted by the single storage authority.');

export const StorageValuesSchema = z
  .record(z.string(), z.unknown())
  .describe('Untrusted storage values validated individually by versioned restoration.');

export type NavigationState = z.infer<typeof NavigationStateSchema>;
export type NavigationProject = z.infer<typeof NavigationProjectSchema>;
export type NavigationTask = z.infer<typeof NavigationTaskSchema>;
export type TabKind = z.infer<typeof TabKindSchema>;
export type CatalogProject = z.infer<typeof CatalogProjectSchema>;
export type CatalogTask = z.infer<typeof CatalogTaskSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
export type ClosedTab = z.infer<typeof ClosedTabSchema>;
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export type WorkspaceAction = z.infer<typeof WorkspaceActionSchema>;

/** Null prototypes keep arbitrary project IDs safe, including __proto__. */
export function dictionary<T>(): Record<string, T> {
  const result: Record<string, T> = {};
  Object.setPrototypeOf(result, null);
  return result;
}
