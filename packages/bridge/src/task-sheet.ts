import {mountDraftRewrite} from '../../ui/src/draft-rewrite.js';
import type {RewriteRequest} from '../../protocol/src/rewrite.js';
import { enhanceSelects } from '../../ui/src/select.js';
import type { Check, Project } from '../../protocol/src/index.js';
import { buildTaskBrief, suggestedTaskName } from '../../protocol/src/task-brief.js';
export interface TaskSheetDependencies {
  projects: Project[];
  selectedProjectId?: string;
  /** Project is captured when opening its task sheet; not a selectable field. */
  scopedProjectId?: string;
  authorize(): Promise<boolean>;
  create(params: Record<string, unknown>): Promise<{id: string}>;
  created(id: string): void;
  start(id: string, mode: 'handoff'|'local'): Promise<unknown>;
  stop(id: string, mode: 'handoff'|'local'): Promise<unknown>;
  rewrite?(request:RewriteRequest,signal:AbortSignal):Promise<string>;
  close(): void;
}
/** Exact production task form, mounted by Solid. Also exercised in Chromium
 * without a substitute mock UI. User text is never inserted as HTML. */
export function mountTaskSheet(root: HTMLElement, deps: TaskSheetDependencies): () => void {
  const scoped = deps.scopedProjectId ? deps.projects.find(p => p.id === deps.scopedProjectId) : undefined;
  if (deps.scopedProjectId && !scoped) throw new Error('This project is no longer available. Open a project before creating a task.');
  root.innerHTML = `<form data-task-form>
    <label class="field" data-project-field><span>Project</span><select data-project required></select></label>
    <label class="field"><span>What should Miter do?</span><textarea data-goal required maxlength="4000" rows="3" placeholder="Make me a skeuomorphic tic-tac-toe game." autofocus></textarea><small>A sentence is enough. Miter adds a build brief and works through it.</small></label>
    <div class="task-rewrite" data-task-rewrite></div>
    <label class="field"><span>Work in</span><select data-workspace><option value="shared">Current folder / branch</option><option value="worktree">New isolated Git worktree</option></select><small>Worktrees require a clean, committed Git repository.</small></label>
    <details class="form-advanced"><summary>Options</summary>
      <label class="field"><span>Task name</span><input data-name maxlength="60" placeholder="Named automatically"/></label>
      <label class="field"><span>Completion checks</span><select data-rule><option value="human">No extra checks</option><option value="exists">A file exists</option><option value="contains">A file contains this text</option><option value="command">A registered test command passes</option></select></label>
      <label class="field" data-path-field hidden><span>Project-relative file</span><input data-path placeholder="index.html" disabled/></label>
      <label class="field" data-text-field hidden><span>Expected text</span><input data-text disabled/></label>
      <label class="field" data-profile-field hidden><span>Command profile</span><select data-profile disabled></select><small>Register test commands in the task’s Tools menu.</small></label>
      <label class="field"><span>Coding source</span><select data-mode><option value="handoff">ChatGPT conversation</option><option value="local">Local coding model</option></select></label>
      <label class="checkline"><input data-start-now type="checkbox" checked/><span>Start after creating the task</span></label>
      <details class="brief-preview"><summary>Preview Miter’s build brief</summary><div data-brief></div></details>
    </details>
    <p class="task-disclosure" data-disclosure>Start shares this task and its project results with ChatGPT. Commands still need your approval.</p>
    <p class="error" data-error role="alert" hidden></p>
    <div class="button-row end"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary" data-create>Start task</button></div>
  </form>`;
  const get = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const form = get<HTMLFormElement>('[data-task-form]'), goal = get<HTMLTextAreaElement>('[data-goal]');
  const project = get<HTMLSelectElement>('[data-project]'), name = get<HTMLInputElement>('[data-name]');
  const mode = get<HTMLSelectElement>('[data-mode]'), rule = get<HTMLSelectElement>('[data-rule]');
  const startNow = get<HTMLInputElement>('[data-start-now]'), submit = get<HTMLButtonElement>('[data-create]');
  const error = get<HTMLElement>('[data-error]'), disclosure = get<HTMLElement>('[data-disclosure]');
  let alive = true, busy = false, completed = false, startingId = '', startingMode: 'handoff'|'local' = 'handoff';
  for (const p of deps.projects) { const option = document.createElement('option'); option.value = p.id; option.textContent = p.name; project.add(option); }
  if (scoped) { project.value = scoped.id; project.disabled = true; get('[data-project-field]').hidden = true; }
  else if (deps.projects.some(p => p.id === deps.selectedProjectId)) project.value = deps.selectedProjectId!;
  // A disabled, hidden native control retains the form source for compatibility;
  // submission always uses the captured project ID, never a later UI selection.
  const selectedProject = () => scoped?.id || project.value;
  let selects: ReturnType<typeof enhanceSelects> | undefined;
  function profiles() {
    const select = get<HTMLSelectElement>('[data-profile]'); select.replaceChildren();
    const option = document.createElement('option'); option.value = ''; option.textContent = 'Choose a registered command'; select.add(option);
    for (const p of deps.projects.find(p => p.id === selectedProject())?.profiles || []) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; select.add(o); }
  }
  function update() {
    submit.textContent = startNow.checked ? 'Start task' : 'Create task';
    disclosure.textContent = !startNow.checked ? 'Creates a task without starting it.' : mode.value === 'local' ? 'Uses your configured local models. Commands still need your approval.' : 'Start shares this task and its project results with ChatGPT. Commands still need your approval.';
    for (const [field, input, visible] of [['[data-path-field]','[data-path]', ['exists','contains'].includes(rule.value)], ['[data-text-field]','[data-text]',rule.value === 'contains'],['[data-profile-field]','[data-profile]',rule.value === 'command']] as const) {
      get(field).hidden = !visible;
      const control = get<HTMLInputElement|HTMLSelectElement>(input); control.disabled = !visible; control.required = visible;
    }
    const brief = buildTaskBrief(goal.value), container = get('[data-brief]'); container.replaceChildren();
    name.placeholder = goal.value.trim() ? brief.title : 'Named automatically';
    for (const [heading, items] of [['Build', brief.approach], ['Quality', brief.quality], ['Defaults — your request comes first', brief.defaults]] as const) {
      const h = document.createElement('h3'); h.textContent = heading; container.append(h);
      const ul = document.createElement('ul'); for (const item of items) { const li = document.createElement('li'); li.textContent = item; ul.append(li); } container.append(ul);
    }
    selects?.refresh();
  }
  profiles(); update();
  selects = enhanceSelects(root);
  const rewrite=mountDraftRewrite(get('[data-task-rewrite]'),goal,{rewrite:deps.rewrite,busyChanged:rewriting=>{submit.disabled=busy||rewriting;}});
  project.addEventListener('change', () => { profiles(); selects?.refresh(); }); goal.addEventListener('input', update);
  rule.addEventListener('change', update); mode.addEventListener('change', update); startNow.addEventListener('change', update);
  get('[data-cancel]').addEventListener('click', () => deps.close());
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || rewrite.busy || !form.reportValidity()) return;
    const cleanGoal = goal.value.replace(/^The goal:\s*/i, '').trim();
    if (!cleanGoal) { goal.setCustomValidity('Describe the result you need.'); goal.reportValidity(); goal.setCustomValidity(''); return; }
    const selectedMode = mode.value as 'handoff'|'local', shouldStart = startNow.checked;
    const checks: Check[] = rule.value === 'human' ? [] : rule.value === 'command' ? [{type:'command',profileId:get<HTMLSelectElement>('[data-profile]').value}]
      : rule.value === 'exists' ? [{type:'exists',path:get<HTMLInputElement>('[data-path]').value}]
      : [{type:'contains',path:get<HTMLInputElement>('[data-path]').value,text:get<HTMLInputElement>('[data-text]').value}];
    const params = {workspaceMode:get<HTMLSelectElement>('[data-workspace]').value,name:name.value.trim() || suggestedTaskName(cleanGoal), goal:cleanGoal, projectId:selectedProject(), checks, mode:selectedMode,maxIterations:15,maxMinutes:30};
    busy = true; rewrite.setDisabled(true); submit.disabled = true; submit.textContent = shouldStart ? 'Starting…' : 'Creating…'; error.hidden = true;
    try {
      // Directly from the click/submit event: preserve Chrome's user gesture.
      if (shouldStart && selectedMode === 'handoff' && !await deps.authorize()) throw new Error('ChatGPT access was not granted. No task was started.');
      if (!alive) return;
      const task = await deps.create(params); deps.created(task.id);
      if (!alive) return; // Closing while creation was pending never starts it.
      if (shouldStart) {
        startingId = task.id; startingMode = selectedMode;
        try { await deps.start(task.id, selectedMode); }
        catch (e) {
          // The task already exists. Do not let a retry create a duplicate.
          completed = true; deps.close(); throw e;
        }
        if (!alive) { await deps.stop(task.id, selectedMode).catch(() => {}); return; }
      }
      completed = true; deps.close();
    } catch (e) {
      if (alive) { error.textContent = e instanceof Error ? e.message : String(e); error.hidden = false; }
    } finally { if (alive) { busy = false; rewrite.setDisabled(false); submit.disabled = rewrite.busy; update(); } }
  });
  queueMicrotask(() => { if (alive) goal.focus(); });
  return () => { alive = false; if (!completed && startingId) void deps.stop(startingId, startingMode).catch(() => {}); rewrite.dispose(); selects?.dispose(); root.replaceChildren(); };
}
