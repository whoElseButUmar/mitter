import { stripVTControlCharacters } from 'node:util';
import { appRunLimits, type AppRunSession } from '../../../../../packages/protocol/src/rpc.js';
import type { TaskBoundary, Worker } from '../../../../../packages/protocol/src/index.js';
import { redact } from '../redaction.js';

export type AppRun = Omit<AppRunSession, 'projectId' | 'name'>;
type ProjectOwner = Pick<Worker, 'projectId' | 'name'>;

/** Volatile output belongs to the app run, independent of workspace tabs and interactive shells. */
export class AppRuns {
  private readonly runs = new Map<string, AppRun>();

  begin(previewId: string, workerId: string, boundary: TaskBoundary): AppRun {
    const run: AppRun = {
      previewId,
      workerId,
      expectedRun: { ...boundary },
      startedAt: Date.now(),
      state: 'starting',
      output: 'Preparing the app…\n',
    };
    this.runs.set(previewId, run);
    if (this.runs.size > appRunLimits.sessions) {
      for (const row of this.runs.values()) {
        if (row.state === 'stopped' || row.state === 'failed') {
          this.runs.delete(row.previewId);
          break;
        }
      }
    }
    return run;
  }

  discard(run: AppRun): void {
    this.runs.delete(run.previewId);
  }

  write(run: AppRun, text: string): void {
    if (run.state !== 'starting' && run.state !== 'running') {
      return;
    }
    const plain = stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
    const safe = redact(plain)
      .replaceAll(run.previewId, '[session]')
      .replace(/\S+/g, (word) => {
        const suffix = word.search(/[?#]/);
        if (suffix >= 0 && (suffix === 0 || word.slice(0, suffix).includes('/'))) {
          return word.slice(0, suffix);
        }
        return word;
      });
    run.output = (run.output + safe).slice(-appRunLimits.output);
  }

  finish(run: AppRun, state: 'stopped' | 'failed', reason: string): void {
    if (run.state !== 'starting' && run.state !== 'running') {
      return;
    }
    this.write(run, reason + '\n');
    run.state = state;
    delete run.url;
  }

  list(projectId: string, owner: (workerId: string) => ProjectOwner | undefined): { runs: AppRunSession[] } {
    const runs: AppRunSession[] = [];
    for (const run of this.runs.values()) {
      const worker = owner(run.workerId);
      if (worker?.projectId === projectId) {
        const name = worker.name.trim().slice(0, 60) || 'App';
        runs.push({ ...run, expectedRun: { ...run.expectedRun }, projectId, name });
      }
    }
    return { runs: runs.reverse() };
  }
}
