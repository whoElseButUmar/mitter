import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import {
  appRunListResultSchema,
  previewStartResultSchema,
  previewStopResultSchema,
  type AppRunSession,
} from '../../../../packages/protocol/src/rpc';
import type { TaskBoundary } from '../../../../packages/protocol/src/index';
import { errorMessage } from '../schemas/primitives';
import { callResult, type ViewRPC } from './rpc';

export type SetupTerminalFocus = { projectId: string; workerId: string; sessionId: string };

export type TerminalRunFocus = TaskBoundary & { projectId: string; workerId: string; failure?: () => string };

export async function openAppPreview(url: string): Promise<void> {
  try {
    await chrome.tabs.create({ url });
  } catch (error) {
    throw new Error('Chrome could not open the app tab. Try Open app in Terminal.', { cause: error });
  }
}

// Keep the same tab through an app restart. Stop still targets an exact server instance.
export function runTabId(workerId: string, boundary: TaskBoundary): string {
  return 'app:' + JSON.stringify([workerId, boundary.runId, boundary.epoch]);
}

export function createTerminalRuns(options: {
  projectId: () => string;
  visible: () => boolean;
  rpc: ViewRPC;
}) {
  const [rows, setRows] = createSignal<AppRunSession[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
  const [confirmedRuns, setConfirmedRuns] = createSignal<
    ReadonlyMap<string, { previewId: string; supersededPreviewId: string }>
  >(new Map());
  let confirmedProject = '';
  let refresh: (() => Promise<void>) | undefined;
  const tabs = createMemo(() => {
    const latest = new Map<string, AppRunSession>();
    for (const row of rows()) {
      if (row.projectId !== options.projectId()) {
        continue;
      }
      const key = runTabId(row.workerId, row.expectedRun);
      if (!latest.has(key)) {
        latest.set(key, row);
      }
    }
    for (const [key, confirmed] of confirmedRuns()) {
      if (latest.get(key)?.previewId !== confirmed.supersededPreviewId) {
        continue;
      }
      const resumed = rows().find(
        (row) =>
          row.projectId === options.projectId() &&
          runTabId(row.workerId, row.expectedRun) === key &&
          row.previewId === confirmed.previewId,
      );
      if (resumed) {
        latest.set(key, resumed);
      }
    }
    for (const row of rows()) {
      const key = runTabId(row.workerId, row.expectedRun);
      if (
        row.projectId === options.projectId() &&
        latest.get(key)?.previewId !== row.previewId &&
        (row.state === 'running' || row.state === 'starting')
      ) {
        // A previous listener stays usable until its replacement is ready.
        latest.set('app:' + row.previewId, row);
      }
    }
    return latest;
  });

  async function listRuns(projectId: string): Promise<AppRunSession[]> {
    const list = await callResult(options.rpc, appRunListResultSchema, 'project.appRuns', { projectId });
    if (list.runs.some((run) => run.projectId !== projectId)) {
      throw new Error('Miter received app sessions for a different project.');
    }
    return list.runs;
  }

  createEffect(() => {
    const projectId = options.projectId();
    const visible = options.visible();
    if (confirmedProject !== projectId) {
      confirmedProject = projectId;
      setConfirmedRuns(new Map());
    }
    setRows([]);
    setLoaded(false);
    setBusy(new Set<string>());
    setError('');
    if (!projectId || !visible) {
      return;
    }

    let active = true;
    let reading = false;
    let readError = '';
    const read = async () => {
      if (!active || reading) {
        return;
      }
      reading = true;
      try {
        const runs = await listRuns(projectId);
        if (active) {
          setRows(runs);
          setLoaded(true);
          if (readError) {
            if (error() === readError) {
              setError('');
            }
            readError = '';
          }
        }
      } catch (reason) {
        if (active) {
          readError = errorMessage(reason);
          setError(readError);
        }
      } finally {
        reading = false;
      }
    };
    refresh = read;
    void read();
    const timer = setInterval(() => void read(), 1000);
    onCleanup(() => {
      active = false;
      clearInterval(timer);
      refresh = undefined;
    });
  });

  async function control(run: AppRunSession, action: 'open' | 'stop' | 'restart') {
    const read = refresh;
    const current = [...tabs().values()].find((row) => row.previewId === run.previewId);
    if (!read || !current || busy().has(run.previewId)) {
      return;
    }
    setBusy((previous) => new Set(previous).add(run.previewId));
    setError('');
    try {
      const params = { workerId: current.workerId, expectedRun: current.expectedRun };
      if (action === 'open') {
        // Another workspace may have stopped or replaced the listener since the last poll.
        const live = (await listRuns(current.projectId)).find((row) => row.previewId === current.previewId);
        if (refresh !== read) {
          return;
        }
        if (
          live?.state !== 'running' ||
          !live.url ||
          live.workerId !== current.workerId ||
          live.expectedRun.runId !== current.expectedRun.runId ||
          live.expectedRun.epoch !== current.expectedRun.epoch
        ) {
          throw new Error('This app session has ended. Select the running session or choose Run again.');
        }
        await openAppPreview(live.url);
      } else if (action === 'stop') {
        await callResult(options.rpc, previewStopResultSchema, 'worker.previewStop', {
          ...params,
          previewId: run.previewId,
        });
      } else {
        const mode: { mode: 'run' | 'restart'; replacePreviewId?: string } = { mode: 'run' };
        if (current.state === 'running') {
          mode.mode = 'restart';
          mode.replacePreviewId = current.previewId;
        }
        const started = await callResult(options.rpc, previewStartResultSchema, 'worker.previewStart', {
          ...params,
          ...mode,
        });
        if (refresh === read) {
          setConfirmedRuns((previous) => {
            const next = new Map(previous);
            next.set(runTabId(current.workerId, current.expectedRun), {
              previewId: started.previewId,
              supersededPreviewId: current.previewId,
            });
            return next;
          });
          if (mode.mode === 'run') {
            await openAppPreview(started.url);
          }
        }
      }
    } catch (reason) {
      if (refresh === read) {
        setError(errorMessage(reason));
      }
    } finally {
      if (refresh === read) {
        setBusy((previous) => {
          const next = new Set(previous);
          next.delete(run.previewId);
          return next;
        });
        await read();
      }
    }
  }

  return { tabs, loaded, error, busy, control, refresh: () => refresh?.() };
}
