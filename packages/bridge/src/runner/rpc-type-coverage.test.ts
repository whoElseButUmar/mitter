import type { z } from 'zod';
import type { Snapshot } from '../../../protocol/src/index.js';
import type {
  handoffSeenResultSchema,
  importResultSchema,
  pauseResultSchema,
  replyValidationResultSchema,
  resumeResultSchema,
  runResultSchema,
} from '../../../protocol/src/rpc.js';
import type { TaskProgress } from '../progress.js';
import type { savedBridgeProgressLoadSchema } from './progress-load.js';
import { requestBridgeRpc } from './rpc-results.js';
import type { BridgeDependencies } from './types.js';

type NativeResultTypeCoverage = {
  prompt: Promise<string>;
  report: Promise<string>;
  seen: Promise<z.infer<typeof handoffSeenResultSchema>>;
  admission: Promise<z.infer<typeof replyValidationResultSchema>>;
  imported: Promise<z.infer<typeof importResultSchema>>;
  run: Promise<z.infer<typeof runResultSchema>>;
  resume: Promise<z.infer<typeof resumeResultSchema>>;
  pause: Promise<z.infer<typeof pauseResultSchema>>;
  state: Promise<Snapshot>;
  load: Promise<z.infer<typeof savedBridgeProgressLoadSchema>>;
  save: Promise<TaskProgress>;
  extend: Promise<TaskProgress>;
};

/** Compile-only coverage: registry composition must retain each method's exact
 * inferred result, rather than widening typed bridge reads to unknown. */
export function nativeResultTypeCoverage(
  rpc: BridgeDependencies['rpc'],
  params: Record<string, unknown>,
): NativeResultTypeCoverage {
  return {
    prompt: requestBridgeRpc(rpc, 'worker.prompt', params),
    report: requestBridgeRpc(rpc, 'worker.report', params),
    seen: requestBridgeRpc(rpc, 'worker.handoffSeen', params),
    admission: requestBridgeRpc(rpc, 'worker.validateReply', params),
    imported: requestBridgeRpc(rpc, 'worker.import', params),
    run: requestBridgeRpc(rpc, 'worker.run', params),
    resume: requestBridgeRpc(rpc, 'worker.resume', params),
    pause: requestBridgeRpc(rpc, 'worker.pause', params),
    state: requestBridgeRpc(rpc, 'state', params),
    load: requestBridgeRpc(rpc, 'worker.bridgeLoad', params),
    save: requestBridgeRpc(rpc, 'worker.bridgeSave', params),
    extend: requestBridgeRpc(rpc, 'worker.bridgeExtend', params),
  };
}
