import type { z } from 'zod';
import { createRpcRegistry, parseRpcParams, parseRpcResult } from '../../../protocol/src/rpc.js';
import { savedTaskProgressSchema, taskProgressSchema } from '../progress.js';
import { savedBridgeProgressLoadSchema } from './progress-load.js';

export {
  promptResultSchema,
  handoffSeenResultSchema,
  replyValidationResultSchema as replyAdmissionResultSchema,
} from '../../../protocol/src/rpc.js';

export const bridgeRpcRegistry = createRpcRegistry({
  progressInput: savedTaskProgressSchema,
  progressResult: taskProgressSchema,
  progressLoadResult: savedBridgeProgressLoadSchema,
});

export type BridgeRpcMethod = keyof typeof bridgeRpcRegistry;
export type BridgeRpcResult<Method extends BridgeRpcMethod> = z.infer<
  (typeof bridgeRpcRegistry)[Method]['result']
>;

export async function requestBridgeRpc<Method extends BridgeRpcMethod>(
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  method: Method,
  params: Record<string, unknown>,
): Promise<BridgeRpcResult<Method>> {
  // The host owns defaults and normalization. Validation inspects the request;
  // dispatch retains its original fields and literal text rather than parsed output.
  parseRpcParams(bridgeRpcRegistry, method, params);
  const result = await rpc(method, params);
  return parseRpcResult(bridgeRpcRegistry, method, result);
}
