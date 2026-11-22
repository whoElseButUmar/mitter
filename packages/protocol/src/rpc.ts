/** Canonical service RPC contracts. Feature owners explicitly compose their own
 * progress/terminal/reset schemas; this base layer imports none of those apps. */
export {
  coreRpcRegistry,
  createRpcRegistry,
  isRpcMethod,
  parseRpcParams,
  parseRpcResult,
  RpcResultValidationError,
  type RpcContract,
  type RpcRegistry,
  type RpcParams,
  type RpcResult,
  type CoreRpcMethod,
} from './rpc/registry.js';
export * from './rpc/files.js';
export * from './rpc/system.js';
export * from './rpc/readiness.js';
export * from './rpc/preview.js';
export * from './rpc/team.js';
export * from './rpc/workflows.js';
export * from './rpc/receipts.js';
export * from './rpc/requests.js';
export { sha256Schema, fileHashSchema, rpcCounterSchema, rpcTimestampSchema } from './rpc/primitives.js';
