import type {
  BrowseResult,
  ChangedFile,
  FileReview,
  FileText,
  Health,
  HistoryResult,
  ImportResult,
  ProjectContext,
  RunResult,
  StateBackup,
  SyntaxCheck,
  Team,
  TeamResult,
} from '../../../../packages/protocol/src/rpc.js';
import type { TaskProgress } from '../../../../packages/bridge/src/progress.js';
import type { BridgeProgressLoad } from '../../../../packages/bridge/src/runner/progress-load.js';
import type {
  TerminalInfo,
  TerminalRead,
  TerminalWritten,
} from '../../../../packages/terminal/src/protocol.js';
import type { HostClient } from '../../src/client.js';
import type { NativeHost, NativeRPC } from '../../src/transport/native-host.js';
import type { TerminalClient } from '../../src/terminal-client.js';
import type { WorkspaceState } from '../../../../packages/ui/src/workspace.js';
import type { NotificationPreferences } from '../../src/schemas/messages.js';
import type { BridgeStartResult, ContinuePendingResult } from '../../src/schemas/local-results.js';
import {
  PreviewMessageSchema,
  PreviewReadySchema,
  type PreviewMessage,
  type PreviewReady,
} from '../../../../packages/ui/src/preview/sandbox-messages.js';

export function inferredSandboxContracts(payload: unknown, readiness: unknown) {
  const message: PreviewMessage = PreviewMessageSchema.parse(payload);
  const ready: PreviewReady = PreviewReadySchema.parse(readiness);
  const kind: 'miter.preview' = message.kind;
  const html: string = message.html;
  const readyKind: 'miter.preview.ready' = ready.kind;

  return { kind, html, readyKind };
}

// This compile-only fixture proves that method literals expose complete schema-inferred results,
// rather than relying on caller generics or a projected response type.
export async function inferredRpcContracts(
  native: NativeRPC,
  host: NativeHost,
  view: HostClient,
  terminal: TerminalClient,
) {
  const projectContext: ProjectContext = await native('project.context', { projectId: 'project' });
  const source: FileText = await host.request('worker.read', { workerId: 'worker', path: 'file.ts' });
  const review: FileReview = await view.request('worker.change', { workerId: 'worker', path: 'file.ts' });
  const changes: ChangedFile[] = await native('worker.files', { workerId: 'worker' });
  const browse: BrowseResult = await view.request('worker.browse', { workerId: 'worker' });
  const syntax: SyntaxCheck = await native('worker.syntax', { workerId: 'worker', path: 'file.js' });
  const health: Health = await view.request('system.health');
  const backup: StateBackup = await host.request('system.backup');
  const history: HistoryResult = await view.request('worker.history', { workerId: 'worker' });
  const team: Team = await view.request('worker.team', { workerId: 'worker' });
  const message: TeamResult = await native('worker.teamMessage', {
    workerId: 'worker',
    id: 'message',
    message: 'Context',
  });
  const imported: ImportResult = await host.request('worker.import', {
    workerId: 'worker',
    text: 'Exact reply',
  });
  const started: RunResult = await view.request('worker.run', { workerId: 'worker' });
  const loaded: BridgeProgressLoad = await native('worker.bridgeLoad', { workerId: 'worker' });
  const progress: TaskProgress = await native('worker.bridgeExtend', { workerId: 'worker', confirm: true });
  const workspace: WorkspaceState = await view.request('workspace.read');
  const preferences: NotificationPreferences = await view.request('notifications.get');
  const admitted: BridgeStartResult = await view.request('bridge.start', {
    workerId: 'worker',
    expectedRun: { runId: 'run', epoch: 7 },
    consent: true,
  });
  const continuation: ContinuePendingResult = await view.request('bridge.continuePending', {
    workerId: 'worker',
    expectedRun: { runId: 'run', epoch: 7 },
  });
  const terminals: TerminalInfo[] = await terminal.request('terminal.list');
  const output: TerminalRead = await terminal.request('terminal.read', { sessionId: 'session', after: 0 });
  const written: TerminalWritten = await terminal.request('terminal.write', {
    sessionId: 'session',
    data: '\r\n',
  });

  return {
    projectContext,
    source,
    review,
    changes,
    browse,
    syntax,
    health,
    backup,
    history,
    team,
    message,
    imported,
    started,
    loaded,
    progress,
    workspace,
    preferences,
    admitted,
    continuation,
    terminals,
    output,
    written,
  };
}
