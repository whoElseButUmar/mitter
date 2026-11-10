import { z } from 'zod';
import { TabKindSchema, WorkspaceStateSchema } from '../workspace/schemas.js';

export const LibraryFilterSchema = z
  .enum(['all', 'open', 'closed', 'active', 'attention', 'complete'])
  .describe('Workspace library filter; never a worker control.');
export const LibraryViewSchema = z.enum(['projects', 'tasks', 'history']).describe('Workspace library list.');
export const LibraryRecordSchema = z
  .object({
    id: z.string().describe('Registered project or task identifier.'),
    projectId: z.string().optional().describe('Owning project for task records.'),
    label: z.string().describe('Display label rendered as text.'),
    subtitle: z.string().describe('Project directory or task goal rendered as text.'),
    status: z.string().describe('Status token used by existing state-dot CSS selectors.'),
    createdAt: z.number().optional().describe('Creation epoch milliseconds, used to order tasks.'),
  })
  .describe('Searchable retained workspace record, independent of open tabs.');

export const LibraryDataSchema = z
  .object({
    view: LibraryViewSchema,
    scopeProjectId: z.string().describe('Selected project used as the default task/history scope.'),
    initialFilter: LibraryFilterSchema.optional(),
    state: WorkspaceStateSchema,
    projects: z.array(LibraryRecordSchema).describe('All retained project records.'),
    tasks: z.array(LibraryRecordSchema).describe('All retained task records.'),
  })
  .describe('Workspace library presentation input, excluding action callbacks.');

export const LibraryRowSchema = z
  .object({
    key: z.string().describe('Stable library row key used to restore focus after rendering.'),
    kind: TabKindSchema,
    id: z.string().describe('Registered project or task identifier.'),
    projectId: z.string().describe('Owning project identifier.'),
    label: z.string().describe('Resolved display name, or retained closed-tab label.'),
    subtitle: z.string().describe('Resolved directory or project/task description.'),
    status: z.string().describe('Record status or unavailable.'),
    opened: z.boolean().describe('Whether the record currently has an open tab.'),
    selected: z.boolean().describe('Whether the record is currently selected.'),
    stamp: z.number().optional().describe('Creation or close epoch milliseconds.'),
    available: z.boolean().describe('Whether the registered record still exists.'),
  })
  .describe('Derived searchable library row, never a task execution request.');

export type LibraryFilter = z.infer<typeof LibraryFilterSchema>;
export type LibraryView = z.infer<typeof LibraryViewSchema>;
export type LibraryRecord = z.infer<typeof LibraryRecordSchema>;
export type LibraryData = z.infer<typeof LibraryDataSchema>;
export type LibraryRow = z.infer<typeof LibraryRowSchema>;

const activeStatuses = new Set([
  'working',
  'connecting',
  'reconnecting',
  'executing',
  'queued',
  'verifying',
  'planning',
  'waiting_model',
  'waiting_lock',
]);
const attentionStatuses = new Set([
  'paused',
  'blocked',
  'review',
  'needs_approval',
  'awaiting_approval',
  'error',
]);

export function libraryRows(
  options: LibraryData,
  view: LibraryView,
  scope: string,
  filter: LibraryFilter,
  query: string,
): LibraryRow[] {
  let rows: LibraryRow[];

  if (view === 'history') {
    rows = options.state.recentlyClosed.map((tab) => {
      let records = options.tasks;

      if (tab.kind === 'project') {
        records = options.projects;
      }

      const record = records.find((record) => record.id === tab.id);
      let subtitle =
        'Task · ' +
        (options.projects.find((project) => project.id === tab.projectId)?.label || 'Unavailable project');

      if (tab.kind === 'project') {
        subtitle = 'Project · ' + (record?.subtitle || 'Unavailable');
      }

      return {
        key: tab.key,
        kind: tab.kind,
        id: tab.id,
        projectId: tab.projectId,
        label: record?.label || tab.label,
        subtitle,
        status: record?.status || 'unavailable',
        opened: false,
        selected: false,
        stamp: tab.closedAt,
        available: !!record,
      };
    });
  } else {
    let records = options.tasks;
    let kind: 'project' | 'task' = 'task';

    if (view === 'projects') {
      records = options.projects;
      kind = 'project';
    }

    rows = records.map((record) => {
      let projectId = record.projectId || '';
      let subtitle = record.subtitle;
      let opened = (options.state.openTasks[projectId] || []).includes(record.id);
      let selected =
        options.state.projectId === projectId && options.state.taskByProject[projectId] === record.id;

      if (kind === 'project') {
        projectId = record.id;
        opened = options.state.openProjects.includes(record.id);
        selected = options.state.projectId === record.id;
      } else {
        subtitle =
          (options.projects.find((project) => project.id === projectId)?.label || '') +
          ' · ' +
          record.subtitle;
      }

      return {
        key: kind + ':' + record.id,
        kind,
        id: record.id,
        projectId,
        label: record.label,
        subtitle,
        status: record.status,
        opened,
        selected,
        stamp: record.createdAt,
        available: true,
      };
    });
  }

  const search = query.toLocaleLowerCase().trim();
  rows = rows.filter(
    (row) =>
      (view === 'projects' || !scope || row.projectId === scope) &&
      (!search || (row.label + ' ' + row.subtitle).toLocaleLowerCase().includes(search)) &&
      (view === 'history' ||
        filter === 'all' ||
        (filter === 'open' && row.opened) ||
        (filter === 'closed' && !row.opened) ||
        (filter === 'active' && activeStatuses.has(row.status)) ||
        (filter === 'attention' && attentionStatuses.has(row.status)) ||
        (filter === 'complete' && row.status === 'complete')),
  );

  if (view === 'tasks') {
    rows.sort((left, right) => (right.stamp || 0) - (left.stamp || 0));
  }

  return rows;
}
