import { addDisclosureMarkers } from '../../ui/src/icons.js';
import { requiredElement } from './sheets/required-element.js';
import { mountDraftRewrite, type DraftRewriteOptions } from '../../ui/src/draft-rewrite.js';
import type { RewriteRequest } from '../../protocol/src/rewrite.js';
import { enhanceSelects } from '../../ui/src/select.js';
import type { Check, Project, Worker } from '../../protocol/src/index.js';
import { identifierSchema } from './schemas/primitives.js';
import {
  coreRpcRegistry,
  parseRpcParams,
  parseRpcResult,
  RpcResultValidationError,
} from '../../protocol/src/rpc.js';
import { NativeRequestTimeout } from './native-request.js';
import { buildTaskBrief, isProjectLaunchRequest, suggestedTaskName } from '../../protocol/src/task-brief.js';
import { taskSheetTemplate } from './sheets/task-template.js';

export type TaskSheetDependencies = {
  projects: Project[];
  selectedProjectId?: string;
  /** Project is captured when opening its task sheet; not a selectable field. */
  scopedProjectId?: string;
  authorize(): Promise<boolean>;
  create(params: Record<string, unknown>): Promise<unknown>;
  created(taskId: string): void;
  start(taskId: string, mode: 'handoff' | 'local'): Promise<unknown>;
  stop(taskId: string, mode: 'handoff' | 'local'): Promise<unknown>;
  rewrite?(request: RewriteRequest, signal: AbortSignal): Promise<string>;
  close(): void;
};

/** Exact production task form, mounted by Solid. Also exercised in Chromium
 * without a substitute mock UI. User text is never inserted as HTML. */
export function mountTaskSheet(root: HTMLElement, deps: TaskSheetDependencies): () => void {
  let scopedProject: Project | undefined;
  if (deps.scopedProjectId) {
    scopedProject = deps.projects.find((project) => project.id === deps.scopedProjectId);
  }
  if (deps.scopedProjectId && !scopedProject) {
    throw new Error('This project is no longer available. Open a project before creating a task.');
  }

  root.innerHTML = taskSheetTemplate;
  addDisclosureMarkers(root);

  const form = requiredElement(root, '[data-task-form]', HTMLFormElement);
  const goalInput = requiredElement(root, '[data-goal]', HTMLTextAreaElement);
  const projectSelect = requiredElement(root, '[data-project]', HTMLSelectElement);
  const nameInput = requiredElement(root, '[data-name]', HTMLInputElement);
  const modeSelect = requiredElement(root, '[data-mode]', HTMLSelectElement);
  const ruleSelect = requiredElement(root, '[data-rule]', HTMLSelectElement);
  const commandCheckOption = requiredElement(root, '[data-command-check]', HTMLOptionElement);
  const commandCheckHint = requiredElement(root, '[data-command-check-hint]', HTMLElement);
  const workspaceSelect = requiredElement(root, '[data-workspace]', HTMLSelectElement);
  const startNowInput = requiredElement(root, '[data-start-now]', HTMLInputElement);
  const submitButton = requiredElement(root, '[data-create]', HTMLButtonElement);
  const errorMessage = requiredElement(root, '[data-error]', HTMLElement);
  const disclosure = requiredElement(root, '[data-disclosure]', HTMLElement);
  const pathField = requiredElement(root, '[data-path-field]', HTMLElement);
  const pathInput = requiredElement(root, '[data-path]', HTMLInputElement);
  const textField = requiredElement(root, '[data-text-field]', HTMLElement);
  const expectedTextInput = requiredElement(root, '[data-text]', HTMLInputElement);
  const profileField = requiredElement(root, '[data-profile-field]', HTMLElement);
  const profileSelect = requiredElement(root, '[data-profile]', HTMLSelectElement);
  const briefContainer = requiredElement(root, '[data-brief]', HTMLElement);
  const advancedOptions = requiredElement(root, '[data-advanced]', HTMLDetailsElement);

  let alive = true;
  let busy = false;
  let completed = false;
  let startingTaskId = '';
  let startingMode: 'handoff' | 'local' = 'handoff';
  let selects: ReturnType<typeof enhanceSelects> | undefined;

  for (const project of deps.projects) {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.name;
    projectSelect.add(option);
  }

  if (scopedProject) {
    projectSelect.value = scopedProject.id;
    projectSelect.disabled = true;
    requiredElement(root, '[data-project-field]', HTMLElement).hidden = true;
    const projectContext = requiredElement(root, '[data-project-context]', HTMLElement);
    projectContext.textContent = 'Project: ' + scopedProject.name;
    projectContext.hidden = false;
  } else {
    const selectedProject = deps.projects.find((project) => project.id === deps.selectedProjectId);
    if (selectedProject) {
      projectSelect.value = selectedProject.id;
    }
  }

  // A disabled, hidden native control retains the form source for compatibility;
  // submission always uses the captured project ID, never a later UI selection.
  const selectedProjectId = () => scopedProject?.id || projectSelect.value;

  function updateCommandProfiles() {
    profileSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a registered command';
    profileSelect.add(placeholder);

    const profiles = deps.projects.find((project) => project.id === selectedProjectId())?.profiles || [];
    commandCheckOption.disabled = profiles.length === 0;
    commandCheckHint.hidden = profiles.length > 0;
    if (!profiles.length && ruleSelect.value === 'command') {
      ruleSelect.value = 'human';
    }
    for (const profile of profiles) {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.label;
      profileSelect.add(option);
    }
  }

  function renderSubmissionDetails() {
    if (!startNowInput.checked) {
      submitButton.textContent = 'Create task';
      disclosure.textContent = 'Creates a task without starting it.';
      return;
    }

    submitButton.textContent = 'Start task';
    if (isProjectLaunchRequest(goalInput.value)) {
      disclosure.textContent =
        'Installs the project dependencies, starts its development server and opens the preview.';
    } else if (modeSelect.value === 'local') {
      disclosure.textContent = 'Uses your configured local models. Commands need your approval.';
    } else {
      disclosure.textContent =
        'Shares this task and project results with ChatGPT. Commands need your approval.';
    }
  }

  function updateCompletionFields() {
    const completionFields = [
      {
        field: pathField,
        control: pathInput,
        visible: ['exists', 'contains'].includes(ruleSelect.value),
      },
      {
        field: textField,
        control: expectedTextInput,
        visible: ruleSelect.value === 'contains',
      },
      {
        field: profileField,
        control: profileSelect,
        visible: ruleSelect.value === 'command',
      },
    ];

    for (const { field, control, visible } of completionFields) {
      field.hidden = !visible;
      control.disabled = !visible;
      control.required = visible;
    }
  }

  function renderBriefPreview() {
    const brief = buildTaskBrief(goalInput.value);
    briefContainer.replaceChildren();
    if (goalInput.value.trim()) {
      nameInput.placeholder = brief.title;
    } else {
      nameInput.placeholder = 'Named automatically';
    }

    const sections = [
      { heading: 'Build', items: brief.approach },
      { heading: 'Quality', items: brief.quality },
      { heading: 'Defaults — your request comes first', items: brief.defaults },
    ];
    for (const { heading, items } of sections) {
      const title = document.createElement('h3');
      title.textContent = heading;
      briefContainer.append(title);

      const list = document.createElement('ul');
      for (const item of items) {
        const entry = document.createElement('li');
        entry.textContent = item;
        list.append(entry);
      }
      briefContainer.append(list);
    }
  }

  function refreshForm() {
    renderSubmissionDetails();
    updateCompletionFields();
    renderBriefPreview();
    selects?.refresh();
  }

  function revealInvalidField(event: Event): void {
    if (event.target instanceof HTMLElement && advancedOptions.contains(event.target)) {
      advancedOptions.open = true;
    }
  }

  function completionChecks(): Check[] {
    switch (ruleSelect.value) {
      case 'human':
        return [];
      case 'command':
        return [{ type: 'command', profileId: profileSelect.value }];
      case 'exists':
        return [{ type: 'exists', path: pathInput.value }];
      default:
        return [
          {
            type: 'contains',
            path: pathInput.value,
            text: expectedTextInput.value,
          },
        ];
    }
  }

  updateCommandProfiles();
  refreshForm();
  selects = enhanceSelects(root);

  const rewriteOptions: DraftRewriteOptions = {
    busyChanged: (rewriting) => {
      submitButton.disabled = busy || rewriting;
    },
  };
  const rewrite = deps.rewrite;
  if (rewrite !== undefined) {
    rewriteOptions.rewrite = rewrite;
  }
  const draftRewrite = mountDraftRewrite(
    requiredElement(root, '[data-task-rewrite]', HTMLElement),
    goalInput,
    rewriteOptions,
  );

  async function stopCreatedTask(taskId: string, mode: 'handoff' | 'local'): Promise<void> {
    const stopped = await deps.stop(taskId, mode);
    if (mode === 'local') {
      parseRpcResult(coreRpcRegistry, 'worker.pause', stopped);
    }
  }

  async function submitTask(event: SubmitEvent) {
    event.preventDefault();
    if (busy || completed || draftRewrite.busy || !form.reportValidity()) {
      return;
    }

    const cleanGoal = goalInput.value.replace(/^The goal:\s*/i, '').trim();
    if (!cleanGoal) {
      goalInput.setCustomValidity('Describe the result you need.');
      goalInput.reportValidity();
      goalInput.setCustomValidity('');
      return;
    }

    let selectedMode = modeSelect.value;
    if (isProjectLaunchRequest(cleanGoal)) {
      selectedMode = 'local';
    }
    if (selectedMode !== 'handoff' && selectedMode !== 'local') {
      modeSelect.setCustomValidity('Choose a coding source.');
      modeSelect.reportValidity();
      modeSelect.setCustomValidity('');
      return;
    }

    const shouldStart = startNowInput.checked;
    const params = {
      workspaceMode: workspaceSelect.value,
      name: nameInput.value.trim() || suggestedTaskName(cleanGoal),
      goal: cleanGoal,
      projectId: selectedProjectId(),
      checks: completionChecks(),
      mode: selectedMode,
      maxIterations: 15,
      maxMinutes: 30,
    };

    busy = true;
    draftRewrite.setDisabled(true);
    submitButton.disabled = true;
    if (shouldStart) {
      submitButton.textContent = 'Starting…';
    } else {
      submitButton.textContent = 'Creating…';
    }
    errorMessage.hidden = true;

    try {
      parseRpcParams(coreRpcRegistry, 'worker.create', params);
      // Directly from the click/submit event: preserve Chrome's user gesture.
      if (shouldStart && selectedMode === 'handoff' && !(await deps.authorize())) {
        throw new Error('ChatGPT access was not granted. No task was started.');
      }
      if (!alive) {
        return;
      }

      let task: Worker;
      try {
        task = parseRpcResult(coreRpcRegistry, 'worker.create', await deps.create(params));
      } catch (error) {
        // Creation may already have committed. An invalid or missing receipt
        // cannot authorize a second creation from this form.
        if (error instanceof NativeRequestTimeout || error instanceof RpcResultValidationError) {
          completed = true;
        }
        throw error;
      }
      const identity = identifierSchema.safeParse(task.id);
      if (!identity.success) {
        completed = true;
        throw new Error(
          'The host returned an invalid task-creation identity. Check saved tasks before creating another.',
          { cause: identity.error },
        );
      }
      if (task.projectId !== params.projectId || task.mode !== selectedMode) {
        completed = true;
        throw new Error(
          'The task-creation result belongs to another project or coding source. Check saved tasks before creating another.',
        );
      }
      deps.created(task.id);
      if (!alive) {
        return;
      } // Closing while creation was pending never starts it.

      if (shouldStart) {
        startingTaskId = task.id;
        startingMode = selectedMode;
        try {
          const started = await deps.start(task.id, selectedMode);
          if (selectedMode === 'local') {
            parseRpcResult(coreRpcRegistry, 'worker.run', started);
          }
        } catch (error) {
          // The task already exists. Do not let a retry create a duplicate.
          completed = true;
          if (alive) {
            deps.close();
          }
          throw error;
        }
        if (!alive) {
          await stopCreatedTask(task.id, selectedMode).catch(() => {});
          return;
        }
      }

      completed = true;
      deps.close();
    } catch (error) {
      if (alive) {
        if (error instanceof Error) {
          errorMessage.textContent = error.message;
        } else {
          errorMessage.textContent = String(error);
        }
        if (completed && error instanceof NativeRequestTimeout) {
          errorMessage.textContent += ' Check saved tasks before creating another.';
        }
        errorMessage.hidden = false;
      }
    } finally {
      if (alive) {
        busy = false;
        draftRewrite.setDisabled(completed);
        submitButton.disabled = completed || draftRewrite.busy;
        refreshForm();
      }
    }
  }

  projectSelect.addEventListener('change', () => {
    updateCommandProfiles();
    refreshForm();
  });
  goalInput.addEventListener('input', refreshForm);
  ruleSelect.addEventListener('change', refreshForm);
  modeSelect.addEventListener('change', refreshForm);
  startNowInput.addEventListener('change', refreshForm);
  requiredElement(root, '[data-cancel]', HTMLElement).addEventListener('click', () => deps.close());
  form.addEventListener('submit', submitTask);
  // Invalid does not bubble. Reveal optional controls before native validation
  // or the enhanced select moves focus to the field that needs attention.
  form.addEventListener('invalid', revealInvalidField, true);

  queueMicrotask(() => {
    if (alive) {
      goalInput.focus();
    }
  });

  return function disposeTaskSheet() {
    alive = false;
    if (!completed && startingTaskId) {
      void stopCreatedTask(startingTaskId, startingMode).catch(() => {});
    }

    draftRewrite.dispose();
    selects?.dispose();
    form.removeEventListener('invalid', revealInvalidField, true);
    root.replaceChildren();
  };
}
