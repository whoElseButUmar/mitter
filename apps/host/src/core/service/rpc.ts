import { createRpcRegistry } from '../../../../../packages/protocol/src/rpc.js';
import { savedTaskProgressSchema, taskProgressSchema } from '../../../../../packages/bridge/src/progress.js';
import { bridgeProgressLoadSchema } from '../../../../../packages/bridge/src/runner/progress-load.js';

export const serviceRpcRegistry = createRpcRegistry({
  progressInput: savedTaskProgressSchema,
  progressResult: taskProgressSchema,
  progressLoadResult: bridgeProgressLoadSchema,
});
