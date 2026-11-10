import { taskBoundarySchema, type TaskBoundary, type Worker } from '../../../../packages/protocol/src/index';

export function reviewedTaskBoundary(task: Worker): TaskBoundary {
  const result = taskBoundarySchema.safeParse({
    runId: task.runId,
    epoch: task.control?.epoch ?? 0,
  });
  if (!result.success) {
    throw new Error('This task’s run boundary is unavailable. Refresh Miter and review the task again.', {
      cause: result.error,
    });
  }
  return result.data;
}
