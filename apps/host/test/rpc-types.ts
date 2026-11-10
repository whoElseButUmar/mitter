import {
  coreRpcRegistry,
  parseRpcParams,
  parseRpcResult,
  type RpcParams,
  type RpcResult,
} from '../../../packages/protocol/src/rpc.js';
import { serviceRpcRegistry } from '../src/core/service/rpc.js';

export function readSource(value: unknown): string {
  return parseRpcResult(coreRpcRegistry, 'worker.read', value).content;
}

export function readPath(params: RpcParams<typeof coreRpcRegistry, 'project.read'>): string {
  return params.path;
}

export function changedBytes(result: RpcResult<typeof coreRpcRegistry, 'worker.files'>): number | undefined {
  return result[0]?.bytes;
}

export function reviewHashes(result: RpcResult<typeof coreRpcRegistry, 'worker.change'>): string[] {
  return [result.beforeHash, result.afterHash, result.currentHash, result.status];
}

export function approvalChoice(value: unknown): boolean | undefined {
  return parseRpcParams(coreRpcRegistry, 'worker.approve', value).approve;
}

export function importedRetry(result: RpcResult<typeof coreRpcRegistry, 'worker.import'>): boolean {
  if ('acknowledged' in result) {
    return result.acknowledged;
  }

  return result.queued;
}

export function restoredCount(value: unknown): number {
  return parseRpcResult(coreRpcRegistry, 'worker.restoreFile', value).restored;
}

export function stoppedEpoch(value: unknown): number {
  return parseRpcResult(coreRpcRegistry, 'worker.stop', value).epoch;
}

export function progressWorker(value: unknown): string {
  return parseRpcParams(serviceRpcRegistry, 'worker.bridgeSave', value).progress.workerId;
}

export function progressTurns(value: unknown): number {
  return parseRpcResult(serviceRpcRegistry, 'worker.bridgeExtend', value).turns;
}

export function loadedProgress(value: unknown): number {
  const result = parseRpcResult(serviceRpcRegistry, 'worker.bridgeLoad', value);

  if (result.progress === null) {
    return result.importedCount;
  }

  return result.progress.revision;
}
