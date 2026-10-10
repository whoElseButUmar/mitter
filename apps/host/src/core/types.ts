import type { WorkerState } from '../../../../packages/protocol/src/index.js';
export interface SqlStatement { run(...values: any[]): { changes: number | bigint; lastInsertRowid: number | bigint }; get(...values: any[]): any; all(...values: any[]): any[] }
export interface SqlDatabase { exec(sql: string): void; prepare(sql: string): SqlStatement; close(): void }
export interface Workflow { get(): WorkerState; move(state: WorkerState): void; stop(): void }
export type WorkflowFactory = (initial: WorkerState, onChange: (state: WorkerState) => void) => Workflow;
export interface Models {
  propose(prompt: string, signal: AbortSignal): Promise<string>;
  close(): void;
}
export class ApprovalNeeded extends Error { constructor() { super('Approval required.'); } }
export class UserQuestion extends Error {}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
