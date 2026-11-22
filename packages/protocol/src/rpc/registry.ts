import { z } from 'zod';
import { object } from '../helpers.js';
import { projectSchema, snapshotSchema, workerSchema } from '../schemas/domain.js';
import { settingsSchema } from '../schemas/model-settings.js';
import { followupSchema } from '../schemas/requests.js';
import {
  assetChunkSchema,
  browseResultSchema,
  changedFilesSchema,
  fileReviewSchema,
  fileTextSchema,
  openedResultSchema,
  syntaxCheckSchema,
  workspaceRollbackSchema,
} from './files.js';
import { folderPickerResultSchema, healthSchema, stateBackupSchema, stateBackupsSchema } from './system.js';
import { readinessParamsSchema, readinessSchema } from './readiness.js';
import {
  appRunListParamsSchema,
  appRunListResultSchema,
  previewPickParamsSchema,
  previewPickResultSchema,
  previewElementSchema,
  previewCancelPickResultSchema,
  previewStatusParamsSchema,
  previewStatusResultSchema,
  previewStartParamsSchema,
  previewStartResultSchema,
  previewStopParamsSchema,
  previewStopResultSchema,
} from './preview.js';
import {
  workflowProjectParamsSchema,
  workflowSaveParamsSchema,
  workflowStateSchema,
  workflowTargetParamsSchema,
} from './workflows.js';
import { teamResultSchema, teamSchema } from './team.js';
import {
  acceptResultSchema,
  approveResultSchema,
  cancelResultSchema,
  continueFreshResultSchema,
  followupActivationSchema,
  followupCancelResultSchema,
  handoffSeenResultSchema,
  historyResultSchema,
  importResultSchema,
  pauseResultSchema,
  projectContextSchema,
  promptResultSchema,
  replyValidationResultSchema,
  reportResultSchema,
  resumeResultSchema,
  runResultSchema,
  skipResultSchema,
  steerResultSchema,
  steerValidationResultSchema,
  stopResultSchema,
  workerSetupDecisionResultSchema,
} from './receipts.js';
import {
  emptyRpcParamsSchema,
  epochParamsSchema,
  projectAddParamsSchema,
  projectCreateParamsSchema,
  projectFolderPickerParamsSchema,
  projectContextParamsSchema,
  projectParamsSchema,
  projectProfileParamsSchema,
  projectReadParamsSchema,
  projectRenameParamsSchema,
  settingsUpdateParamsSchema,
  verifyBackupParamsSchema,
  workerAcceptParamsSchema,
  workerApproveParamsSchema,
  workerAssetParamsSchema,
  workerBridgeExtendParamsSchema,
  workerBrowseParamsSchema,
  workerCreateParamsSchema,
  workerFileParamsSchema,
  workerFollowupCancelParamsSchema,
  workerFollowupParamsSchema,
  workerHandoffSeenParamsSchema,
  workerHistoryParamsSchema,
  workerImportParamsSchema,
  workerOpenFileParamsSchema,
  workerParamsSchema,
  workerPromptParamsSchema,
  workerReadParamsSchema,
  workerRenameParamsSchema,
  workerReplyParamsSchema,
  workerRestoreFileParamsSchema,
  workerRollbackParamsSchema,
  workerRunParamsSchema,
  workerSetupDecisionParamsSchema,
  workerSkipParamsSchema,
  workerStopParamsSchema,
  workerTeamMessageParamsSchema,
} from './requests.js';

// Schema objects are dependencies, not serialized contracts.
export type RpcContract = {
  readonly params: z.ZodType;
  readonly result: z.ZodType;
  readonly mutation: boolean;
};
export type RpcRegistry = Readonly<Record<string, RpcContract>>;

function contract<Params extends z.ZodType, Result extends z.ZodType>(
  params: Params,
  result: Result,
  mutation = false,
) {
  return Object.freeze({ params, result, mutation });
}

export const coreRpcRegistry = Object.freeze({
  state: contract(emptyRpcParamsSchema, snapshotSchema),
  'workflow.list': contract(workflowProjectParamsSchema, workflowStateSchema),
  'workflow.record': contract(workflowProjectParamsSchema, workflowStateSchema, true),
  'workflow.expect': contract(workflowProjectParamsSchema, workflowStateSchema, true),
  'workflow.save': contract(workflowSaveParamsSchema, workflowStateSchema, true),
  'workflow.cancel': contract(workflowProjectParamsSchema, workflowStateSchema, true),
  'workflow.replay': contract(workflowTargetParamsSchema, workflowStateSchema, true),
  'workflow.delete': contract(workflowTargetParamsSchema, workflowStateSchema, true),
  'system.health': contract(emptyRpcParamsSchema, healthSchema),
  'system.readiness': contract(readinessParamsSchema, readinessSchema),
  'project.appRuns': contract(appRunListParamsSchema, appRunListResultSchema),
  'worker.previewStatus': contract(previewStatusParamsSchema, previewStatusResultSchema),
  'worker.previewStart': contract(previewStartParamsSchema, previewStartResultSchema, true),
  'worker.pickElement': contract(previewPickParamsSchema, previewPickResultSchema, true),
  'worker.cancelPick': contract(previewPickParamsSchema, previewCancelPickResultSchema, true),
  'worker.previewStop': contract(previewStopParamsSchema, previewStopResultSchema, true),
  'system.backups': contract(emptyRpcParamsSchema, stateBackupsSchema),
  'system.backup': contract(emptyRpcParamsSchema, stateBackupSchema, true),
  'system.verifyBackup': contract(verifyBackupParamsSchema, stateBackupSchema),
  'project.pickFolder': contract(projectFolderPickerParamsSchema, folderPickerResultSchema),
  'project.reveal': contract(projectParamsSchema, openedResultSchema, true),
  'project.read': contract(projectReadParamsSchema, fileTextSchema),
  'project.context': contract(projectContextParamsSchema, projectContextSchema, true),
  'project.rename': contract(projectRenameParamsSchema, projectSchema, true),
  'project.add': contract(projectAddParamsSchema, projectSchema, true),
  'project.starterTask': contract(
    projectParamsSchema.strict().describe('Open the launch task belonging to this starter project.'),
    workerSchema,
    true,
  ),
  'project.create': contract(projectCreateParamsSchema, projectSchema, true),
  'project.profile': contract(projectProfileParamsSchema, projectSchema, true),
  'worker.create': contract(workerCreateParamsSchema, workerSchema, true),
  'settings.update': contract(settingsUpdateParamsSchema, settingsSchema, true),
  'worker.steerValidate': contract(workerFollowupParamsSchema, steerValidationResultSchema),
  'worker.stop': contract(workerStopParamsSchema, stopResultSchema, true),
  'worker.steer': contract(workerFollowupParamsSchema, steerResultSchema, true),
  'worker.continueFresh': contract(workerParamsSchema, continueFreshResultSchema, true),
  'worker.reveal': contract(workerParamsSchema, openedResultSchema, true),
  'worker.read': contract(workerReadParamsSchema, fileTextSchema),
  'worker.browse': contract(workerBrowseParamsSchema, browseResultSchema),
  'worker.asset': contract(workerAssetParamsSchema, assetChunkSchema),
  'worker.openFile': contract(workerOpenFileParamsSchema, openedResultSchema, true),
  'worker.followups': contract(
    workerParamsSchema,
    z.array(followupSchema).describe('Complete retained follow-up records in queue order.'),
  ),
  'worker.followup': contract(workerFollowupParamsSchema, followupSchema, true),
  'worker.followupCancel': contract(workerFollowupCancelParamsSchema, followupCancelResultSchema, true),
  'worker.followupActivate': contract(workerParamsSchema, followupActivationSchema, true),
  'worker.team': contract(workerParamsSchema, teamSchema),
  'worker.teamMessage': contract(workerTeamMessageParamsSchema, teamResultSchema, true),
  'worker.rename': contract(workerRenameParamsSchema, workerSchema, true),
  'worker.prompt': contract(workerPromptParamsSchema, promptResultSchema),
  'worker.history': contract(workerHistoryParamsSchema, historyResultSchema),
  'worker.previewSelection': contract(
    workerParamsSchema,
    previewElementSchema.nullable().describe('The attached local preview selection, if any.'),
  ),
  'worker.report': contract(workerParamsSchema, reportResultSchema),
  'worker.handoffSeen': contract(workerHandoffSeenParamsSchema, handoffSeenResultSchema),
  'worker.change': contract(workerFileParamsSchema, fileReviewSchema),
  'worker.syntax': contract(workerFileParamsSchema, syntaxCheckSchema),
  'worker.restoreFile': contract(workerRestoreFileParamsSchema, workspaceRollbackSchema, true),
  'worker.files': contract(workerParamsSchema, changedFilesSchema),
  'worker.validateReply': contract(workerReplyParamsSchema, replyValidationResultSchema),
  'worker.import': contract(workerImportParamsSchema, importResultSchema, true),
  'worker.run': contract(workerRunParamsSchema, runResultSchema, true),
  'worker.resume': contract(epochParamsSchema, resumeResultSchema, true),
  'worker.pause': contract(epochParamsSchema, pauseResultSchema, true),
  'worker.cancel': contract(epochParamsSchema, cancelResultSchema, true),
  'worker.approve': contract(workerApproveParamsSchema, approveResultSchema, true),
  'worker.setupDecision': contract(workerSetupDecisionParamsSchema, workerSetupDecisionResultSchema, true),
  'worker.skip': contract(workerSkipParamsSchema, skipResultSchema, true),
  'worker.rollback': contract(workerRollbackParamsSchema, workspaceRollbackSchema, true),
  'worker.accept': contract(workerAcceptParamsSchema, acceptResultSchema, true),
});

/** Feature owners supply their real schemas explicitly. There is deliberately no
 * unknown/default progress contract and no import from bridge, terminal or host. */
export function createRpcRegistry<
  ProgressInput extends z.ZodType,
  ProgressResult extends z.ZodType,
  ProgressLoadResult extends z.ZodType,
>(progress: {
  progressInput: ProgressInput;
  progressResult: ProgressResult;
  progressLoadResult: ProgressLoadResult;
}) {
  return Object.freeze({
    ...coreRpcRegistry,
    'worker.bridgeLoad': contract(workerParamsSchema, progress.progressLoadResult),
    'worker.bridgeSave': contract(
      epochParamsSchema
        .extend({
          progress: progress.progressInput.describe(
            'The complete owner-validated progress, including supported migrations.',
          ),
        })
        .describe(
          'A task progress save; run/epoch, goal binding, revision and monotonic counters still gate persistence.',
        ),
      progress.progressResult,
      true,
    ),
    'worker.bridgeExtend': contract(workerBridgeExtendParamsSchema, progress.progressResult, true),
  });
}

export type RpcParams<Registry extends RpcRegistry, Method extends keyof Registry> = z.infer<
  Registry[Method]['params']
>;
export type RpcResult<Registry extends RpcRegistry, Method extends keyof Registry> = z.infer<
  Registry[Method]['result']
>;
export type CoreRpcMethod = keyof typeof coreRpcRegistry;

export function isRpcMethod<Registry extends RpcRegistry>(
  registry: Registry,
  method: string,
): method is keyof Registry & string {
  return Object.hasOwn(registry, method);
}

function getContract(registry: RpcRegistry, method: string): RpcContract {
  if (!Object.hasOwn(registry, method)) {
    throw new Error('Unknown request method.');
  }

  const entry = registry[method];

  if (entry === undefined) {
    throw new Error('Unknown request method.');
  }

  return entry;
}

export function parseRpcParams<Registry extends RpcRegistry, Method extends keyof Registry & string>(
  registry: Registry,
  method: Method,
  value: unknown,
  message?: string,
): RpcParams<Registry, Method>;
export function parseRpcParams(
  registry: RpcRegistry,
  method: string,
  value: unknown,
  message?: string,
): unknown;
export function parseRpcParams(
  registry: RpcRegistry,
  method: string,
  value: unknown,
  message?: string,
): unknown {
  const entry = getContract(registry, method);
  const params = object(value, 'params');
  const parsed = entry.params.safeParse(params);

  if (!parsed.success) {
    let explanation = message;

    if (explanation === undefined) {
      explanation = parsed.error.issues[0]?.message ?? 'Invalid request parameters.';
    }

    throw new Error(explanation, { cause: parsed.error });
  }

  return parsed.data;
}

export class RpcResultValidationError extends Error {
  readonly code = 'RPC_RESULT_INVALID';
  readonly retryable = false;

  constructor(
    readonly method: string,
    mutation: boolean,
    cause: z.ZodError,
  ) {
    let message = 'The host returned an invalid result for ' + method + '.';

    if (mutation) {
      message += ' The operation may already have completed. Check saved state before repeating it.';
    }

    super(message, { cause });
    this.name = 'RpcResultValidationError';
  }
}

export function parseRpcResult<Registry extends RpcRegistry, Method extends keyof Registry & string>(
  registry: Registry,
  method: Method,
  value: unknown,
): RpcResult<Registry, Method>;
export function parseRpcResult(registry: RpcRegistry, method: string, value: unknown): unknown;
export function parseRpcResult(registry: RpcRegistry, method: string, value: unknown): unknown {
  const entry = getContract(registry, method);
  const parsed = entry.result.safeParse(value);

  if (!parsed.success) {
    throw new RpcResultValidationError(method, entry.mutation, parsed.error);
  }

  return parsed.data;
}
