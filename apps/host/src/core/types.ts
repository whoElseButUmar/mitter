import type { WorkerState } from '../../../../packages/protocol/src/index.js';

export type SqlValue = string | number | bigint | null | Uint8Array;

export type SqlStatement = {
  run(...values: SqlValue[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };

  get(...values: SqlValue[]): unknown;

  all(...values: SqlValue[]): unknown[];
};

export type SqlDatabase = {
  exec(sql: string): void;

  prepare(sql: string): SqlStatement;

  close(): void;
};

export type Workflow = {
  get(): WorkerState;

  move(state: WorkerState): void;

  stop(): void;
};

export type WorkflowFactory = (initial: WorkerState, onChange: (state: WorkerState) => void) => Workflow;

export type Models = {
  propose(prompt: string, signal: AbortSignal): Promise<unknown>;

  close(): void;
};

export class ApprovalNeeded extends Error {
  constructor() {
    super('Approval required.');
  }
}

export class UserQuestion extends Error {}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/** Structural narrowing for native resources, not a serialized-data parser. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
