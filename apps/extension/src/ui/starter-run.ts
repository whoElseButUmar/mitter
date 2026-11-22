import { createMemo, createSignal, onCleanup } from 'solid-js';
import { isProjectLaunchRequest } from '../../../../packages/protocol/src/task-brief';
import { workerSchema, type Worker } from '../../../../packages/protocol/src/index';
import { previewStartResultSchema, runResultSchema } from '../../../../packages/protocol/src/rpc';
import { errorMessage } from '../schemas/primitives';
import { callResult, type ViewRPC } from './rpc';
import { reviewedTaskBoundary } from './task-boundary';

export function createStarterRun(options: {
  rpc: ViewRPC;
  projectId: () => string;
  openTask: (id: string) => Promise<boolean>;
  showTerminal: (task: Worker) => (message: string) => void;
  failed: (message: string) => void;
}) {
  const [starting, setStarting] = createSignal<ReadonlySet<string>>(new Set());
  let active = true;
  const projectScope = createMemo<{ id: string }>((previous) => {
    const id = options.projectId();
    if (previous?.id === id) {
      return previous;
    }
    return { id };
  });
  onCleanup(() => {
    active = false;
  });

  async function run(projectId: string) {
    const owner = projectScope();
    const current = () => active && owner === projectScope() && projectId === owner.id;
    if (!current() || starting().has(projectId)) {
      return;
    }
    setStarting((previous) => new Set(previous).add(projectId));
    let reportPreviewError: ((message: string) => void) | undefined;
    try {
      const task = await callResult(options.rpc, workerSchema, 'project.starterTask', { projectId });
      if (!current()) {
        return;
      }
      if (
        task.projectId !== projectId ||
        task.mode !== 'local' ||
        task.worktree ||
        task.hasPreviewSelection ||
        !isProjectLaunchRequest(task.goal)
      ) {
        throw new Error(
          'Miter could not verify the launch task for this project. Reopen the project and try again.',
        );
      }
      if (!(await options.openTask(task.id)) || !current()) {
        return;
      }
      const params = { workerId: task.id, expectedRun: reviewedTaskBoundary(task) };
      if (task.pending || task.activeFollowupId) {
        return;
      }
      if (task.control?.mode === 'stopped' && task.state === 'cancelled') {
        await callResult(options.rpc, runResultSchema, 'bridge.continueFresh', params);
      } else if (
        task.control?.mode !== 'stopped' &&
        ['idle', 'blocked', 'paused', 'cancelled'].includes(task.state)
      ) {
        await callResult(options.rpc, runResultSchema, 'worker.run', params);
      } else if (task.state === 'complete') {
        reportPreviewError = options.showTerminal(task);
        await callResult(options.rpc, previewStartResultSchema, 'worker.previewStart', {
          ...params,
          mode: 'run',
        });
      }
    } catch (failure) {
      if (current()) {
        const message = errorMessage(failure);
        reportPreviewError?.(message);
        options.failed(message);
      }
    } finally {
      if (active) {
        setStarting((previous) => {
          const next = new Set(previous);
          next.delete(projectId);
          return next;
        });
      }
    }
  }
  return { run, starting };
}
