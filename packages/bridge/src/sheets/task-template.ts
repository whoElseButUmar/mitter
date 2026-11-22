export const taskSheetTemplate = `<form class="creation-form" data-task-form>
    <p class="task-project-context" data-project-context hidden></p>
    <label class="field" data-project-field><span>Project</span><select data-project required></select></label>
    <label class="field"><span>What should Miter do?</span><textarea data-goal required maxlength="4000" rows="3" placeholder="Build a room booking app with a weekly calendar." autofocus></textarea></label>
    <div class="task-rewrite" data-task-rewrite></div>
    <details class="form-advanced" data-advanced><summary>Advanced options</summary>
      <label class="field"><span>Task name (optional)</span><input data-name maxlength="60" placeholder="Named automatically"/></label>
      <label class="field"><span>Coding source</span><select data-mode><option value="handoff">ChatGPT conversation</option><option value="local">Local coding model</option></select></label>
      <label class="field" data-workspace-field><span>Work in</span><select data-workspace><option value="shared">Current project folder</option><option value="worktree">New isolated Git worktree</option></select><small>Worktrees need a clean, committed Git repository.</small></label>
      <label class="field"><span>Extra completion checks</span><select data-rule><option value="human">No extra checks</option><option value="exists">A file exists</option><option value="contains">A file contains this text</option><option value="command" data-command-check>A registered test command passes</option></select><small data-command-check-hint hidden>Add a command in Actions → Test commands, then reopen New task.</small></label>
      <label class="field" data-path-field hidden><span>Project-relative file</span><input data-path placeholder="index.html" disabled/></label>
      <label class="field" data-text-field hidden><span>Expected text</span><input data-text disabled/></label>
      <label class="field" data-profile-field hidden><span>Test command</span><select data-profile disabled></select></label>
      <label class="checkline"><input data-start-now type="checkbox" checked/><span>Start after creating the task</span></label>
      <p class="muted small">Built-in skills and quality checks stay on.</p>
      <details class="brief-preview"><summary>Preview Miter’s build brief</summary><div data-brief></div></details>
    </details>
    <p class="task-disclosure" data-disclosure>Shares this task and project results with ChatGPT. Commands need your approval.</p>
    <p class="error" data-error role="alert" hidden></p>
    <div class="button-row end"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary" data-create>Start task</button></div>
  </form>`;
