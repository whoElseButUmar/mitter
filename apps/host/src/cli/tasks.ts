import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import {
  terminalStartParamsSchema,
  terminalVersionMismatchMessage,
  type TerminalOperation,
} from '../../../../packages/protocol/src/terminal-control.js';
import { errorMessage } from '../core/types.js';
import { TerminalControlError } from '../core/terminal-control/client.js';
import type { TerminalArguments } from './arguments.js';

import { readable, printOperation, printStatus } from './output.js';
import { watchTask, type TaskDependencies, type ResumeWatch } from './watch.js';

export async function readGoalFile(filePath: string): Promise<string> {
  const file = await fs.open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16000) {
      throw new Error(
        'The goal file must be a regular UTF-8 file of at most 16,000 bytes and 4,000 UTF-16 code units.',
      );
    }
    const bytes = Buffer.alloc(16001);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > 16000) {
      throw new Error('The goal file exceeds 16,000 bytes.');
    }
    const goal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, read.bytesRead),
    );
    return terminalStartParamsSchema.shape.goal.parse(goal);
  } catch (error) {
    throw new Error(
      'Could not read the goal file. Use valid UTF-8, nonblank text without NUL characters, up to 4,000 UTF-16 code units.',
      {
        cause: error,
      },
    );
  } finally {
    await file.close();
  }
}

function operationExit(operation: TerminalOperation): number {
  if (operation.state === 'failed' || operation.state === 'interrupted') {
    return 1;
  }
  return 0;
}

export async function runTaskCommand(
  arguments_: TerminalArguments,
  dependencies: TaskDependencies,
): Promise<number> {
  const client = dependencies.client;
  let mutationId: string | undefined;
  try {
    if (arguments_.command === 'start') {
      let goal = arguments_.goal;
      if (arguments_.goalFile !== undefined) {
        goal = await readGoalFile(arguments_.goalFile);
      }
      const params = terminalStartParamsSchema.parse({
        requestId: arguments_.requestId ?? randomUUID(),
        projectPath: arguments_.projectPath,
        createProject: arguments_.createProject,
        name: arguments_.name,
        goal,
        maxTurns: arguments_.maxTurns,
        maxMinutes: arguments_.maxMinutes,
        consent: true,
      });
      mutationId = params.requestId;
      dependencies.err('Request: ' + mutationId);
      const operation = await client.start(params);
      mutationId = undefined;
      printOperation(operation, arguments_.json, dependencies);
      const code = operationExit(operation);
      if (code !== 0 || !arguments_.watch || !operation.workerId) {
        return code;
      }
      return await watchTask(operation.workerId, arguments_.json, dependencies, operation.expectedRun);
    }
    if (arguments_.command === 'stop' || arguments_.command === 'resume') {
      const status = await client.status(arguments_.workerId);
      mutationId = arguments_.requestId ?? randomUUID();
      dependencies.err('Request: ' + mutationId);
      const params = {
        requestId: mutationId,
        workerId: arguments_.workerId,
        expectedRun: status.worker.expectedRun,
      };
      let operation: TerminalOperation;
      if (arguments_.command === 'resume') {
        operation = await client.resume(params);
      } else {
        operation = await client.stop(params);
      }
      mutationId = undefined;
      printOperation(operation, arguments_.json, dependencies);
      const code = operationExit(operation);
      if (arguments_.command === 'resume' && arguments_.watch && code === 0) {
        let resume: ResumeWatch | undefined;
        if (operation.state !== 'succeeded') {
          resume = {
            requestId: operation.requestId,
            previousProgress: status.progress,
            previousWorker: { state: status.worker.state, error: status.worker.error },
          };
        }
        return await watchTask(
          arguments_.workerId,
          arguments_.json,
          dependencies,
          operation.expectedRun,
          resume,
        );
      }
      return code;
    }
    if (arguments_.command === 'preview') {
      const status = await client.status(arguments_.workerId);
      const { id: workerId, expectedRun } = status.worker;
      const preview = await client.preview({ workerId, expectedRun });
      if (arguments_.json) {
        dependencies.out(JSON.stringify({ type: 'preview', workerId, expectedRun, ...preview }));
      } else {
        dependencies.out(preview.url);
        dependencies.out(readable(preview.detail));
      }
      return 0;
    }
    if (arguments_.command === 'status') {
      printStatus(await client.status(arguments_.workerId), arguments_.json, dependencies);
      return 0;
    }
    if (arguments_.command === 'operation') {
      const operation = await client.operation(arguments_.requestId);
      printOperation(operation, arguments_.json, dependencies);
      return operationExit(operation);
    }
    if (arguments_.command === 'watch') {
      return await watchTask(arguments_.workerId, arguments_.json, dependencies);
    }
    if (arguments_.command === 'list') {
      const result = await client.list();
      if (arguments_.json) {
        dependencies.out(JSON.stringify({ type: 'list', ...result }));
      } else if (result.tasks.length === 0) {
        dependencies.out(
          'No tasks yet. Start one with miter start --project /absolute/folder --goal "Your task".',
        );
      } else {
        for (const task of result.tasks) {
          dependencies.out(readable(task.id) + '  ' + task.state + '  ' + readable(task.name));
        }
      }
      if (!result.browserConnected && result.browserVersionMismatch) {
        dependencies.err(readable(terminalVersionMismatchMessage(result.browserVersionMismatch)));
      } else if (!result.browserConnected) {
        dependencies.err('Chrome is not connected. Open Miter in Chrome before starting or stopping tasks.');
      }
      return 0;
    }
    throw new Error('This command does not control a running task.');
  } catch (error) {
    if (dependencies.signal.aborted) {
      dependencies.err('Monitoring stopped. The task was not cancelled; use miter stop TASK_ID to stop it.');
    } else {
      dependencies.err(readable(errorMessage(error)));
    }
    if (mutationId && (!(error instanceof TerminalControlError) || error.delivery === 'unknown')) {
      let caution = 'Do not repeat this operation with a new request ID.';
      if (arguments_.command === 'start') {
        caution = 'Do not start again with a new request ID.';
      }
      dependencies.err(
        'The request may have been accepted. Check: miter operation ' + mutationId + '. ' + caution,
      );
    }
    if (dependencies.signal.aborted) {
      return 130;
    }
    return 1;
  }
}
