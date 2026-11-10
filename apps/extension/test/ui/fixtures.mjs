import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { workerSchema } from '../../../../packages/protocol/src/index.ts';
import { bridgeStatusSchema } from '../../../../packages/bridge/src/runner/types.ts';
import { bridgeStartResultSchema } from '../../src/schemas/local-results.ts';

export function worker(overrides = {}) {
  return workerSchema.parse({
    id: 'worker_1',
    projectId: 'project_1',
    name: 'Example task',
    goal: 'Keep this task intact.',
    checks: [],
    mode: 'handoff',
    state: 'idle',
    queue: [],
    cursor: 0,
    runId: 'run_1',
    iteration: 0,
    maxIterations: 15,
    maxMinutes: 30,
    startedAt: 1,
    autoCommands: false,
    observations: [],
    repeatCount: 0,
    createdAt: 1,
    ...overrides,
  });
}

export function bridge(overrides = {}) {
  return bridgeStatusSchema.parse({
    workerId: 'worker_1',
    tabId: 1,
    url: 'https://chatgpt.com/',
    active: false,
    phase: 'stopped',
    reason: 'Paused by the user.',
    turns: 3,
    maxTurns: 15,
    startedAt: 1,
    ...overrides,
  });
}

export function admittedChat(
  workerId = 'worker_a',
  admissionId = 'admitted_start',
  expectedRun = { runId: 'reviewed_run', epoch: 3 },
) {
  return bridgeStartResultSchema.parse({
    ...bridge({ workerId, active: true, phase: 'connecting' }),
    admissionId,
    expectedRun,
  });
}

export function control(mode) {
  return {
    version: 1,
    epoch: 1,
    mode,
    at: 1,
    operationId: 'operation_1',
    reason: 'User action',
    retiredExchanges: [],
  };
}

export function assetChunk(path, text, mime = 'text/plain') {
  const bytes = Buffer.from(text);
  return {
    path,
    mime,
    size: bytes.length,
    offset: 0,
    stamp: createHash('sha256').update(bytes).digest('hex'),
    data: bytes.toString('base64'),
    eof: true,
  };
}

export async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

export async function waitFor(condition, description) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for ' + description + '.');
    }
    await delay(5);
  }
}
