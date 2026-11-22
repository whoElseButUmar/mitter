import type { z } from 'zod';
import type { ImageAttachment } from '../src/schemas/image-attachments.js';
import type {
  Action,
  Check,
  Envelope,
  Worker,
  Snapshot,
  Request,
  Response,
  Settings,
  Profile,
  Project,
  Approval,
  TaskBoundary,
  TaskControl,
  CompletionRecord,
  WorkerState,
  Activity,
  BridgeProgressSummary,
  actionSchema,
  envelopeSchema,
  workerSchema,
  taskBoundarySchema,
  coreRpcRegistry,
  RpcParams,
  RpcResult,
  FileText,
} from '../src/index.js';
import { parseEnvelopeWith } from '../src/index.js';
import type { ReferencedEdit, ProposalAction, ProposalEnvelope } from '../src/proposal.js';
import type { CodeSelection, Followup, FollowupState, FollowupSummary } from '../src/requests.js';
import type { RewriteMode, RewriteProvider, RewriteRequest } from '../src/rewrite.js';
import type { TaskBrief } from '../src/task-brief.js';
import type { ReplyIssue } from '../src/validation.js';
import type { NativeMessageInbox } from '../src/native-transfer.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
type Assert<Value extends true> = Value;

/** Before exactOptionalPropertyTypes, optional properties also permitted explicit
 * undefined. These historical fixtures spell out that permission so enabling the
 * flag does not reinterpret the old contract or weaken the equality assertions. */
type LegacyAction =
  | { type: 'list'; path: string }
  | { type: 'read'; path: string; offset?: number | undefined; limit?: number | undefined }
  | { type: 'search'; query: string }
  | { type: 'write'; path: string; content: string; expectedHash: string }
  | {
      type: 'replace';
      path: string;
      before: string;
      after: string;
      expectedHash: string;
    }
  | { type: 'command'; profileId: string }
  | { type: 'diff' }
  | { type: 'team_message'; message: string; to?: string | undefined }
  | { type: 'team_pause'; workerId: string; reason: string; seconds: number }
  | { type: 'team_resume'; workerId: string; context: string }
  | { type: 'finish'; summary: string }
  | { type: 'ask'; question: string };

type SkillAction = {
  type: 'skill';
  name: 'caveman' | 'no-ai-slop' | 'ponytail' | 'app-design' | 'engineering-quality';
  asset?: 'foundation.css' | 'components.mjs' | 'vite-api.mjs' | undefined;
};

type LegacyEnvelope = {
  protocol: 'mitter/1';
  id: string;
  workerId: string;
  projectId: string;
  summary: string;
  actions: Action[];
  replyTo?: string | undefined;
};

type LegacyWorker = {
  completion?: CompletionRecord | undefined;
  control?: TaskControl | undefined;
  id: string;
  projectId: string;
  name: string;
  goal: string;
  checks: Check[];
  mode: 'handoff' | 'local';
  state: WorkerState;
  queue: Envelope[];
  cursor: number;
  runId: string;
  iteration: number;
  maxIterations: number;
  maxMinutes: number;
  startedAt: number;
  setupWaitMs?: number | undefined;
  pending?: Approval | undefined;
  approvedFingerprint?: string | undefined;
  autoCommands: boolean;
  humanAcceptanceReady?: boolean | undefined;
  error?: string | undefined;
  observations: string[];
  activeFollowupId?: string | undefined;
  followups?: FollowupSummary[] | undefined;
  worktree?: { root: string; branch: string; baseCommit: string } | undefined;
  teamPaused?: string | undefined;
  lastProposal?: string | undefined;
  repeatCount: number;
  createdAt: number;
};

const callbackEnvelope = parseEnvelopeWith('{}', (value) => ({
  observed: value,
}));

type PreviewFinish = Extract<LegacyAction, { type: 'finish' }> & { openPreview?: true | undefined };
type CurrentActions =
  | Exclude<LegacyAction, { type: 'finish' }>
  | { [Key in keyof PreviewFinish]: PreviewFinish[Key] }
  | SkillAction
  | { type: 'setupCommand'; command: string[]; purpose: string; effects: string }
  | {
      type: 'saveImage';
      path: string;
      source: { type: 'web'; url: string } | { type: 'generated'; index: number };
    };

/** Compile-only assertions cover the read-only skill action and the optional framework launch. */
export type PublicTypeChecks = [
  Assert<Equal<RpcResult<typeof coreRpcRegistry, 'worker.read'>, FileText>>,
  Assert<Equal<RpcParams<typeof coreRpcRegistry, 'project.read'>['path'], string>>,
  Assert<Equal<Action, CurrentActions>>,
  Assert<Equal<Envelope, LegacyEnvelope>>,
  Assert<
    Equal<Omit<Worker, 'hasPreviewSelection' | 'imageAttachments' | 'activeFollowupImages'>, LegacyWorker>
  >,
  Assert<Equal<Worker['hasPreviewSelection'], true | undefined>>,
  Assert<Equal<Worker['imageAttachments'], ImageAttachment[] | undefined>>,
  Assert<Equal<Worker['activeFollowupImages'], ImageAttachment[] | undefined>>,
  Assert<Equal<Action, z.infer<typeof actionSchema>>>,
  Assert<Equal<Envelope, z.infer<typeof envelopeSchema>>>,
  Assert<Equal<Worker, z.infer<typeof workerSchema>>>,
  Assert<Equal<TaskBoundary, { runId: string; epoch: number }>>,
  Assert<Equal<TaskBoundary, z.infer<typeof taskBoundarySchema>>>,
  Assert<
    Equal<
      Settings,
      {
        coderModelPath: string;
        contextSize: number;
        maxTokens: number;
        gpu: 'auto' | 'cpu';
      }
    >
  >,
  Assert<Equal<Request, { id: string; method: string; params: Record<string, unknown> }>>,
  Assert<
    Equal<Response, { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string }>
  >,
  Assert<Equal<ProposalAction, Action | ReferencedEdit>>,
  Assert<
    Equal<
      ReferencedEdit,
      | { type: 'write'; path: string; content: string; base: string }
      | { type: 'replace'; path: string; before: string; after: string; base: string }
    >
  >,
  Assert<
    ProposalEnvelope extends Omit<Envelope, 'actions'> & {
      actions: ProposalAction[];
    }
      ? true
      : false
  >,
  Assert<
    Omit<Envelope, 'actions'> & {
      actions: ProposalAction[];
    } extends ProposalEnvelope
      ? true
      : false
  >,
  Assert<Equal<CodeSelection, { path: string; hash: string; start: number; end: number; text: string }>>,
  Assert<Equal<RewriteMode, 'clarity' | 'concise' | 'technical' | 'steps' | 'checks' | 'polish'>>,
  Assert<Equal<RewriteProvider, 'local' | 'chatgpt'>>,
  Assert<Equal<RewriteRequest, { instruction: string; mode: RewriteMode; provider: RewriteProvider }>>,
  Assert<Equal<typeof callbackEnvelope.actions, { observed: unknown }[]>>,
  Assert<Equal<ReturnType<NativeMessageInbox['accept']>, unknown>>,
];

/** Every original public serialized type remains importable at its original path. */
export type OriginalPublicTypes =
  | Check
  | Snapshot
  | Profile
  | Project
  | Activity
  | BridgeProgressSummary
  | Followup
  | FollowupState
  | TaskBrief
  | ReplyIssue;
