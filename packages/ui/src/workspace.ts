/** Durable UI workspace. Tab visibility never controls task execution. */
import { WORKSPACE_NAV_KEY } from './workspace-state.js';

export {
  TabKindSchema,
  CatalogProjectSchema,
  CatalogTaskSchema,
  CatalogSchema,
  ClosedTabSchema,
  WorkspaceStateSchema,
  WorkspaceActionSchema,
  type TabKind,
  type CatalogProject,
  type CatalogTask,
  type Catalog,
  type ClosedTab,
  type WorkspaceState,
  type WorkspaceAction,
} from './workspace/schemas.js';
export {
  emptyWorkspace,
  currentTask,
  restoreWorkspace,
  reconcileWorkspace,
  HISTORY_LIMIT,
} from './workspace/restore.js';
export { reduceWorkspace, validateWorkspaceAction } from './workspace/reducer.js';

export const WORKSPACE_KEY = 'mitter.workspace.v2';
export const LEGACY_WORKSPACE_KEY = WORKSPACE_NAV_KEY;
