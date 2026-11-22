import type { Page } from 'puppeteer-core';
import { dispatchPageAction, executeStep } from '../quality/browser-journeys.js';
import { errorMessage } from '../types.js';
import { installRecorder } from './recorder-page.js';
import { workflowStepsSchema, type WorkflowSteps } from './runtime-contract.js';
import { visitWorkflowPage, WorkflowPreview } from './runtime-preview.js';

export async function attachRecording(page: Page, origin: string) {
  const steps: WorkflowSteps = [];
  let overflow = false;
  let awaitingSelection = false;
  const recorder = await installRecorder(page, origin, (step) => {
    if (step.type === 'expect') {
      awaitingSelection = false;
    }
    const last = steps.at(-1);
    if (step.type === 'fill' && last?.type === 'fill' && last.selector === step.selector) {
      last.value = step.value;
    } else if (steps.length < 32) {
      steps.push(step);
    } else {
      overflow = true;
    }
  });
  return {
    async expect() {
      // Each document owns its picker. Reloading the app lets the user arm the new one.
      const previous = awaitingSelection;
      awaitingSelection = true;
      try {
        await recorder.arm();
      } catch (error) {
        awaitingSelection = previous;
        throw error;
      }
    },
    dispose: recorder.dispose,
    read(): WorkflowSteps {
      if (awaitingSelection) {
        throw new Error('Choose the expected result in the recording window.');
      }
      if (overflow) {
        throw new Error('A workflow can contain up to 32 steps. Start a shorter recording.');
      }
      const result = workflowStepsSchema.safeParse(steps);
      if (!result.success) {
        throw new Error('Perform an action and choose its final result before saving the workflow.');
      }
      return result.data;
    },
  };
}

export async function beginRecording(projectRoot: string, signal: AbortSignal) {
  const preview = await WorkflowPreview.create(projectRoot, signal);
  let recorder: Awaited<ReturnType<typeof attachRecording>> | undefined;
  let closing: Promise<void> | undefined;
  const closed = Promise.withResolvers<void>();
  const close = (): Promise<void> => {
    closing ??= Promise.resolve()
      .then(async () => {
        signal.removeEventListener('abort', interrupted);
        try {
          await recorder?.dispose();
        } finally {
          await preview.close();
        }
      })
      .finally(() => closed.resolve());
    return closing;
  };
  const interrupted = () => void close().catch(() => {});
  try {
    const { page, url } = await preview.launch(false);
    recorder = await attachRecording(page, new URL(url).origin);
    const recording = recorder;
    await visitWorkflowPage(page, url);
    await page.bringToFront();
    page.once('close', interrupted);
    page.browser().once('disconnected', interrupted);
    signal.addEventListener('abort', interrupted, { once: true });
    signal.throwIfAborted();
    return {
      closed: closed.promise,
      close,
      expect: recording.expect,
      async finish() {
        return recording.read();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function replayWorkflow(
  projectRoot: string,
  steps: WorkflowSteps,
  verifyAfterRestart: boolean,
  signal: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const ordered = workflowStepsSchema.parse(steps);
  let preview: WorkflowPreview | undefined;
  let phase = 'Opening the workflow';
  try {
    preview = await WorkflowPreview.create(projectRoot, signal);
    const { page, url } = await preview.launch(true);
    await visitWorkflowPage(page, url);
    for (const [index, step] of ordered.entries()) {
      signal.throwIfAborted();
      phase = 'Step ' + (index + 1) + ' (' + step.type + ')';
      if (new URL(page.url()).origin !== new URL(url).origin) {
        throw new Error('The page left its project preview.');
      }
      if (step.type === 'click' || step.type === 'press') {
        await dispatchPageAction(page, step);
      } else {
        await executeStep(page, step);
      }
    }
    if (verifyAfterRestart) {
      phase = 'Checking the result after server restart';
      const before = new URL(page.url());
      if (before.origin !== new URL(url).origin) {
        throw new Error('The selected result is outside the project preview.');
      }
      await page.waitForNetworkIdle({ timeout: 5000 });
      await preview.stop();
      // Restart the actual app with only its disposable server data. Browser storage,
      // workers and in-memory state cannot satisfy the post-restart assertion.
      const next = await preview.launch(true);
      await visitWorkflowPage(next.page, next.url);
      const route = new URL(next.url);
      route.pathname = before.pathname;
      route.search = before.search;
      route.hash = before.hash;
      if (route.href !== next.page.url()) {
        // A hash-only goto would keep the entry document and skip startup route handling.
        // The capability entry above established the framework's protected preview cookie.
        await next.page.goto('about:blank');
        await visitWorkflowPage(next.page, route.href);
      }
      const result = ordered.at(-1);
      if (result?.type === 'expect') {
        await executeStep(next.page, result);
      }
      signal.throwIfAborted();
      return { ok: true, detail: 'The recorded result passed before and after server restart.' };
    }
    signal.throwIfAborted();
    return { ok: true, detail: 'The recorded actions and result passed.' };
  } catch (error) {
    signal.throwIfAborted();
    // Driver diagnostics can contain full preview capabilities or recorded field values.
    if (phase === 'Opening the workflow') {
      return { ok: false, detail: 'Could not open the workflow preview. Check that this project runs.' };
    }
    if (errorMessage(error).includes('project changed')) {
      return { ok: false, detail: 'The project changed during replay. Run the workflow again.' };
    }
    return { ok: false, detail: phase + ' failed. Open the app to inspect the recorded outcome.' };
  } finally {
    await preview?.close();
  }
}
