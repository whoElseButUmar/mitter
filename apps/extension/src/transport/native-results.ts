import { parseRpcResult } from '../../../../packages/protocol/src/rpc.js';
import { nativeRpcRegistry } from '../schemas/native-rpc.js';

export { promptResultSchema } from '../../../../packages/protocol/src/rpc.js';

export function parseNativeResult(method: string, result: unknown): unknown {
  return parseRpcResult(nativeRpcRegistry, method, result);
}
