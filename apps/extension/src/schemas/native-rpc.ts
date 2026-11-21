import { z } from 'zod';
import { createRpcRegistry, type RpcResult } from '../../../../packages/protocol/src/rpc.js';
import { savedTaskProgressSchema, taskProgressSchema } from '../../../../packages/bridge/src/progress.js';
import { bridgeProgressLoadSchema } from '../../../../packages/bridge/src/runner/progress-load.js';
import {
  resetPreparationSchema,
  resetCleanupResultSchema,
  resetCompletionSchema,
} from '../../../../packages/bridge/src/data-reset.js';
import { nativeTerminalRpcRegistry } from './terminal.js';
import {
  terminalClaimParamsSchema,
  terminalClaimResultSchema,
  terminalCompleteParamsSchema,
  terminalCompleteResultSchema,
} from '../../../../packages/protocol/src/terminal-control.js';

const resetParametersSchema = z
  .strictObject({
    confirmation: z.literal('CLEAR').describe('The exact human-confirmed destructive reset text.'),
  })
  .describe('Explicit reset confirmation; the reset coordinator still owns admission and cleanup barriers.');

export const progressRpcRegistry = createRpcRegistry({
  progressInput: savedTaskProgressSchema,
  progressResult: taskProgressSchema,
  progressLoadResult: bridgeProgressLoadSchema,
});

export const resetRpcRegistry = Object.freeze({
  'system.resetPrepare': { params: resetParametersSchema, result: resetPreparationSchema, mutation: true },
  'system.reset': { params: resetParametersSchema, result: resetCleanupResultSchema, mutation: true },
  'system.resetComplete': { params: resetParametersSchema, result: resetCompletionSchema, mutation: true },
});

export const nativeRpcRegistry = Object.freeze({
  ...progressRpcRegistry,
  ...nativeTerminalRpcRegistry,
  ...resetRpcRegistry,
  'terminal.claim': { params: terminalClaimParamsSchema, result: terminalClaimResultSchema, mutation: true },
  'terminal.complete': {
    params: terminalCompleteParamsSchema,
    result: terminalCompleteResultSchema,
    mutation: true,
  },
});

export type NativeRpcMethod = keyof typeof nativeRpcRegistry;
export type NativeRpcResult<Method extends NativeRpcMethod> = RpcResult<typeof nativeRpcRegistry, Method>;
