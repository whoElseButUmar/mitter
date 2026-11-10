import type { Worker } from '../../../protocol/src/index.js';
import { parseReceipt, type OutboundReceipt } from '../message-wire.js';
import { PageBridgeError } from '../page-transport.js';
import type { TaskProgress } from '../progress.js';
import { parseRpcResult, RpcResultValidationError } from '../../../protocol/src/rpc.js';
import { bridgeRpcRegistry, type BridgeRpcResult } from './rpc-results.js';
import type { BridgeOptions } from './types.js';

/** Recover counters and the newest task-bound legacy receipt without deciding
 * whether any page message or queued batch may be executed. */
export function recoverTaskProgress(
  loaded: unknown,
  worker: Pick<Worker, 'id' | 'projectId' | 'control'>,
  options: Pick<BridgeOptions, 'lastReceipt' | 'maxTurns' | 'maxMinutes' | 'resumeExisting'>,
  goalHash: string,
  now: () => number,
): TaskProgress {
  let parsedLoad: BridgeRpcResult<'worker.bridgeLoad'>;
  try {
    parsedLoad = parseRpcResult(bridgeRpcRegistry, 'worker.bridgeLoad', loaded);
  } catch (error) {
    if (!(error instanceof RpcResultValidationError)) {
      throw error;
    }
    throw new PageBridgeError(
      'PROGRESS_VERSION',
      'Saved task progress is not compatible. It was not reset.',
      false,
      { cause: error.cause },
    );
  }
  const { importedCount } = parsedLoad;
  let progress = parsedLoad.progress ?? undefined;
  if (
    progress &&
    (progress.workerId !== worker.id ||
      progress.projectId !== worker.projectId ||
      progress.goalHash !== goalHash)
  ) {
    throw new PageBridgeError('PROGRESS_BINDING', 'Saved progress belongs to a different task or goal.');
  }
  let browserReceipt: OutboundReceipt | undefined;
  if (!worker.control) {
    const receipt = parseReceipt(options.lastReceipt);
    if (
      receipt?.workerId === worker.id &&
      receipt.projectId === worker.projectId &&
      receipt.goalHash === goalHash
    ) {
      browserReceipt = receipt;
    }
  }
  if (!progress) {
    const knownTurns = Math.max(0, importedCount, browserReceipt?.turn ?? 0);
    let stage: TaskProgress['stage'] = 'ready';
    if (worker.control?.mode === 'fresh') {
      stage = 'report_due';
    } else if (browserReceipt) {
      stage = 'waiting_reply';
    }
    progress = {
      version: 1,
      revision: 0,
      workerId: worker.id,
      projectId: worker.projectId,
      goalHash,
      turns: knownTurns,
      maxTurns: Math.max(knownTurns, options.maxTurns),
      lowerBound: !!knownTurns || options.resumeExisting === true,
      activeMs: 0,
      maxMinutes: options.maxMinutes,
      startedAt: now(),
      updatedAt: now(),
      stage,
      lastReceipt: browserReceipt,
      repeats: 0,
      formatRepairs: 0,
      phase: 'stopped',
      reason: 'Progress recovered.',
    };
  }
  // Older releases update only the browser receipt. Prefer a newer fully bound
  // receipt without rolling back counters, and ignore it under host control.
  if (browserReceipt && browserReceipt.at > (progress.lastReceipt?.at ?? -1)) {
    progress.lastReceipt = browserReceipt;
    progress.stage = 'waiting_reply';
    progress.lowerBound = true;
    progress.turns = Math.max(progress.turns, browserReceipt.turn ?? 0);
  }
  if (importedCount > progress.turns) {
    progress.turns = importedCount;
    progress.lowerBound = true;
  }
  return progress;
}
