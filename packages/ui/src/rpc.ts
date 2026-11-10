import { coreRpcRegistry, parseRpcParams, parseRpcResult, type RpcResult } from '../../protocol/src/rpc.js';

type RpcTransport = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export async function callCoreRpc<Method extends keyof typeof coreRpcRegistry>(
  rpc: RpcTransport,
  method: Method,
  params: Record<string, unknown> = {},
): Promise<RpcResult<typeof coreRpcRegistry, Method>> {
  // Validate without replacing host-owned defaults or caller-supplied authority on the wire.
  parseRpcParams(coreRpcRegistry, method, params);
  return parseRpcResult(coreRpcRegistry, method, await rpc(method, params));
}
