import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  maxProjectWorkflows,
  workflowSummarySchema,
  type ProjectWorkflowState,
} from '../../../../../packages/protocol/src/rpc.js';
import type { Project } from '../../../../../packages/protocol/src/index.js';
import type { Store } from '../database.js';
import { repairFindingText } from '../redaction.js';
import { errorMessage } from '../types.js';
import { workflowStepsSchema } from './runtime-contract.js';
import { beginRecording, replayWorkflow } from './runtime.js';

const savedWorkflows = z
  .array(workflowSummarySchema.extend({ steps: workflowStepsSchema }))
  .max(maxProjectWorkflows);
const recordingLifetime = 30 * 60 * 1000;

type WorkflowProject = Pick<Project, 'id' | 'root'>;
type Recording = Awaited<ReturnType<typeof beginRecording>>;
type OpenRecording = { session: Recording; timer: NodeJS.Timeout };
type Operation = { key: string; controller: AbortController; done: Promise<ProjectWorkflowState> };

export class ProjectWorkflows {
  private readonly recordings = new Map<string, OpenRecording>();
  private readonly pending = new Map<string, Operation>();
  private readonly cancellations = new Map<string, Promise<ProjectWorkflowState>>();
  private closing = false;

  constructor(
    private readonly store: Pick<Store, 'get' | 'set'>,
    private readonly runtime = { beginRecording, replayWorkflow },
  ) {}

  private saved(projectId: string) {
    return this.store.get('workflows:' + projectId, savedWorkflows) ?? [];
  }

  list(projectId: string): ProjectWorkflowState {
    return {
      recording: this.recordings.has(projectId),
      workflows: this.saved(projectId).map(({ steps: _steps, ...summary }) => summary),
    };
  }

  private mutate(projectId: string, key: string, act: (signal: AbortSignal) => Promise<void>) {
    if (this.closing) {
      throw new Error('Host is shutting down.');
    }
    if (this.cancellations.has(projectId)) {
      throw new Error('The previous workflow is still closing.');
    }
    const busy = this.pending.get(projectId);
    if (busy) {
      if (busy.key === key && !busy.controller.signal.aborted) {
        return busy.done;
      }
      throw new Error('A workflow action is already in progress for this project.');
    }
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return act(controller.signal);
      })
      .then(() => this.list(projectId))
      .finally(() => this.pending.delete(projectId));
    this.pending.set(projectId, { key, controller, done });
    return done;
  }

  record(project: WorkflowProject) {
    return this.mutate(project.id, 'record', async (signal) => {
      if (this.recordings.has(project.id)) {
        return;
      }
      const session = await this.runtime.beginRecording(project.root, signal);
      if (signal.aborted) {
        await session.close();
        signal.throwIfAborted();
      }

      const timer = setTimeout(() => void session.close().catch(() => {}), recordingLifetime);
      timer.unref();
      this.recordings.set(project.id, { session, timer });
      void session.closed.then(() => this.forget(project.id, session));
    });
  }

  private forget(projectId: string, session: Recording) {
    const active = this.recordings.get(projectId);
    if (active?.session !== session) {
      return;
    }
    clearTimeout(active.timer);
    this.recordings.delete(projectId);
  }

  private session(projectId: string) {
    const active = this.recordings.get(projectId);
    if (!active) {
      throw new Error('Open a recording before choosing an expectation or saving.');
    }
    return active.session;
  }

  expect(projectId: string) {
    return this.mutate(projectId, 'expect', async () => this.session(projectId).expect());
  }

  save(projectId: string, name: string, verifyAfterRestart: boolean) {
    name = name.trim();
    return this.mutate(projectId, JSON.stringify(['save', name, verifyAfterRestart]), async (signal) => {
      const workflows = this.saved(projectId);
      const previous = workflows.at(-1);
      if (
        !this.recordings.has(projectId) &&
        previous?.name === name &&
        previous.verifyAfterRestart === verifyAfterRestart
      ) {
        return;
      }
      const session = this.session(projectId);
      if (workflows.length >= maxProjectWorkflows) {
        throw new Error('Remove an older workflow before saving another.');
      }
      if (workflows.some((workflow) => workflow.name === name)) {
        throw new Error('A workflow with this name already exists. Choose another name.');
      }
      const steps = workflowStepsSchema.parse(await session.finish());
      signal.throwIfAborted();
      this.store.set('workflows:' + projectId, [
        ...workflows,
        { id: randomUUID(), name, verifyAfterRestart, steps },
      ]);
      await session.close();
      this.forget(projectId, session);
    });
  }

  cancel(projectId: string) {
    const closing = this.cancellations.get(projectId);
    if (closing) {
      return closing;
    }
    const done = this.stop(projectId).finally(() => this.cancellations.delete(projectId));
    this.cancellations.set(projectId, done);
    return done;
  }

  private async stop(projectId: string) {
    const pending = this.pending.get(projectId);
    const active = this.recordings.get(projectId);
    pending?.controller.abort(new Error('Workflow cancelled.'));
    if (active) {
      await active.session.close();
      this.forget(projectId, active.session);
    }
    await pending?.done.catch(() => {});
    return this.list(projectId);
  }

  remove(projectId: string, id: string) {
    return this.mutate(projectId, 'delete:' + id, async () => {
      const retained = this.saved(projectId).filter((workflow) => workflow.id !== id);
      this.store.set('workflows:' + projectId, retained);
    });
  }

  replay(project: WorkflowProject, id: string, callerSignal?: AbortSignal) {
    callerSignal?.throwIfAborted();
    return this.mutate(project.id, JSON.stringify(['replay', id, project.root]), async (localSignal) => {
      if (this.recordings.has(project.id)) {
        throw new Error('Save or cancel the open workflow recording first.');
      }
      const workflows = this.saved(project.id);
      const workflow = workflows.find((entry) => entry.id === id);
      if (!workflow) {
        throw new Error('Workflow not found in this project.');
      }
      let signal = localSignal;
      if (callerSignal) {
        signal = AbortSignal.any([localSignal, callerSignal]);
      }
      let result;
      try {
        result = await this.runtime.replayWorkflow(
          project.root,
          workflow.steps,
          workflow.verifyAfterRestart,
          signal,
        );
      } catch (error) {
        result = { ok: false, detail: errorMessage(error) };
      }
      signal.throwIfAborted();
      workflow.lastResult = {
        ok: result.ok,
        detail:
          repairFindingText(result.detail).replaceAll('\0', '').slice(0, 2000) ||
          'Replay returned no detail.',
      };
      this.store.set('workflows:' + project.id, workflows);
    });
  }

  async close() {
    this.closing = true;
    const ids = new Set([...this.recordings.keys(), ...this.pending.keys(), ...this.cancellations.keys()]);
    const results = await Promise.allSettled([...ids].map((id) => this.cancel(id)));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
  }
}
