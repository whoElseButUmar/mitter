import {
  coreRpcRegistry,
  parseRpcParams,
  parseRpcResult,
  type RpcResult,
} from '../../../../packages/protocol/src/rpc.js';
import { localRpcRegistry } from './local-results.js';
import { restoreFileParametersSchema, rollbackParametersSchema } from './requests.js';

/** This is the existing view capability allowlist, not the full native registry. */
export const forwardedRpcRegistry = Object.freeze({
  state: coreRpcRegistry.state,
  'system.health': coreRpcRegistry['system.health'],
  'system.readiness': coreRpcRegistry['system.readiness'],
  'worker.previewStatus': coreRpcRegistry['worker.previewStatus'],
  'project.appRuns': coreRpcRegistry['project.appRuns'],
  'worker.previewStart': coreRpcRegistry['worker.previewStart'],
  'worker.previewStop': coreRpcRegistry['worker.previewStop'],
  'worker.pickElement': coreRpcRegistry['worker.pickElement'],
  'worker.cancelPick': coreRpcRegistry['worker.cancelPick'],
  'system.backups': coreRpcRegistry['system.backups'],
  'system.backup': coreRpcRegistry['system.backup'],
  'system.verifyBackup': coreRpcRegistry['system.verifyBackup'],
  'project.context': coreRpcRegistry['project.context'],
  'project.add': coreRpcRegistry['project.add'],
  'project.create': coreRpcRegistry['project.create'],
  'project.starterTask': coreRpcRegistry['project.starterTask'],
  'project.rename': coreRpcRegistry['project.rename'],
  'project.pickFolder': coreRpcRegistry['project.pickFolder'],
  'project.reveal': coreRpcRegistry['project.reveal'],
  'project.read': coreRpcRegistry['project.read'],
  'workflow.list': coreRpcRegistry['workflow.list'],
  'workflow.record': coreRpcRegistry['workflow.record'],
  'workflow.expect': coreRpcRegistry['workflow.expect'],
  'workflow.save': coreRpcRegistry['workflow.save'],
  'workflow.cancel': coreRpcRegistry['workflow.cancel'],
  'workflow.replay': coreRpcRegistry['workflow.replay'],
  'workflow.delete': coreRpcRegistry['workflow.delete'],
  'project.profile': coreRpcRegistry['project.profile'],
  'worker.change': coreRpcRegistry['worker.change'],
  'worker.restoreFile': { ...coreRpcRegistry['worker.restoreFile'], params: restoreFileParametersSchema },
  'worker.syntax': coreRpcRegistry['worker.syntax'],
  'worker.reveal': coreRpcRegistry['worker.reveal'],
  'worker.read': coreRpcRegistry['worker.read'],
  'worker.browse': coreRpcRegistry['worker.browse'],
  'worker.asset': coreRpcRegistry['worker.asset'],
  'worker.openFile': coreRpcRegistry['worker.openFile'],
  'worker.team': coreRpcRegistry['worker.team'],
  'worker.teamMessage': coreRpcRegistry['worker.teamMessage'],
  'worker.followups': coreRpcRegistry['worker.followups'],
  'worker.followupCancel': coreRpcRegistry['worker.followupCancel'],
  'worker.create': coreRpcRegistry['worker.create'],
  'worker.rename': coreRpcRegistry['worker.rename'],
  'worker.run': coreRpcRegistry['worker.run'],
  'worker.resume': coreRpcRegistry['worker.resume'],
  'worker.pause': coreRpcRegistry['worker.pause'],
  'worker.cancel': coreRpcRegistry['worker.cancel'],
  'worker.approve': coreRpcRegistry['worker.approve'],
  'worker.setupDecision': coreRpcRegistry['worker.setupDecision'],
  'worker.skip': coreRpcRegistry['worker.skip'],
  'worker.rollback': { ...coreRpcRegistry['worker.rollback'], params: rollbackParametersSchema },
  'worker.accept': coreRpcRegistry['worker.accept'],
  'worker.prompt': coreRpcRegistry['worker.prompt'],
  'worker.previewSelection': coreRpcRegistry['worker.previewSelection'],
  'worker.report': coreRpcRegistry['worker.report'],
  'worker.history': coreRpcRegistry['worker.history'],
  'worker.import': coreRpcRegistry['worker.import'],
  'worker.files': coreRpcRegistry['worker.files'],
  'worker.handoffSeen': coreRpcRegistry['worker.handoffSeen'],
  'settings.update': coreRpcRegistry['settings.update'],
});

export const forwardedMethods = new Set(Object.keys(forwardedRpcRegistry));
export const viewRpcRegistry = Object.freeze({ ...forwardedRpcRegistry, ...localRpcRegistry });
export type ViewRpcMethod = keyof typeof viewRpcRegistry;
export type ViewRpcResult<Method extends ViewRpcMethod> = RpcResult<typeof viewRpcRegistry, Method>;

export function validateViewParams(method: string, params: unknown): void {
  // The receiver owns defaults; validation must not normalize caller-owned wire parameters.
  parseRpcParams(viewRpcRegistry, method, params);
}

export function parseViewResult(method: string, result: unknown): unknown {
  return parseRpcResult(viewRpcRegistry, method, result);
}
