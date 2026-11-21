import { requireElement } from '../ui/dom';
import { onMount, onCleanup, Show } from 'solid-js';
import { Modal } from '../components';
import { mountTaskSheet, type TaskSheetDependencies } from '../../../../packages/bridge/src/task-sheet';
import type { TaskBoundary, Worker } from '../../../../packages/protocol/src/index';
import { reviewedTaskBoundary } from '../ui/task-boundary';
import type { ViewRPC } from '../ui/rpc';
import { createChatStartCleanup } from '../ui/chat-start-cleanup';
import { createReadiness } from '../ui/readiness';

type WorkerFormProps = Omit<TaskSheetDependencies, 'create' | 'start'> & {
  rpc: ViewRPC;
  create: (params: Record<string, unknown>) => Promise<Worker>;
  start: (taskId: string, mode: Worker['mode'], expectedRun: TaskBoundary) => Promise<unknown>;
  failed: (error: unknown) => void;
};

export function startCreatedTask(
  rpc: ViewRPC,
  workerId: string,
  mode: Worker['mode'],
  expectedRun: TaskBoundary,
) {
  if (mode === 'handoff') {
    return rpc('bridge.start', {
      workerId,
      expectedRun,
      consent: true,
      newChat: true,
      maxTurns: 15,
      maxMinutes: 30,
    });
  }
  return rpc('worker.run', { workerId, expectedRun });
}

export function createWorkerFormRequests(
  options: Pick<WorkerFormProps, 'create' | 'start' | 'stop' | 'close' | 'rpc' | 'failed'>,
) {
  const cleanup = createChatStartCleanup(options.rpc);
  let alive = true;
  let createdTarget: { workerId: string; expectedRun: TaskBoundary } | undefined;
  onCleanup(() => {
    alive = false;
    createdTarget = undefined;
  });

  const create = async (params: Record<string, unknown>) => {
    if (!alive) {
      throw new Error('This task dialog is closed. Reopen New task before continuing.');
    }
    const task = await options.create(params);
    if (!alive) {
      throw new Error('This task dialog is closed. The created task was not started.');
    }
    createdTarget = { workerId: task.id, expectedRun: reviewedTaskBoundary(task) };
    return task;
  };
  const start = async (workerId: string, mode: Worker['mode']) => {
    if (!alive || !createdTarget || createdTarget.workerId !== workerId) {
      throw new Error('This task was not created by the open dialog. Review it before starting.');
    }
    const expectedRun = createdTarget.expectedRun;
    try {
      if (mode === 'handoff') {
        return await cleanup.start(() => options.start(workerId, mode, expectedRun));
      }
      return await options.start(workerId, mode, expectedRun);
    } catch (error) {
      if (alive) {
        options.failed(error);
      }
      throw error;
    }
  };
  const stop = (workerId: string, mode: Worker['mode']) => {
    if (mode === 'handoff') {
      return cleanup.stop();
    }
    return options.stop(workerId, mode);
  };
  const close = () => {
    if (alive) {
      alive = false;
      options.close();
    }
  };

  return { create, start, stop, close };
}

export function WorkerForm(props: WorkerFormProps) {
  const requests = createWorkerFormRequests(props);
  const readiness = createReadiness(() => true, props.rpc);
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const dispose = mountTaskSheet(requireElement(root, 'forms root'), { ...props, ...requests });
    onCleanup(dispose);
  });

  return (
    <Modal title="New task" close={requests.close}>
      <Show when={readiness.report()?.webChecks.status === 'unavailable'}>
        <div class="setup-attention" role="status">
          <strong>Web-app checks need setup</strong>
          <p>{readiness.report()?.webChecks.detail}</p>
          <p>{readiness.report()?.webChecks.hint}</p>
        </div>
      </Show>
      <Show when={readiness.error()}>
        <p class="muted small" role="status">
          Local requirements could not be checked. Open Setup &amp; connection in Help.
        </p>
      </Show>
      <div
        ref={(element) => {
          root = element;
        }}
      />
    </Modal>
  );
}
