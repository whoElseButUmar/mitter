export const taskSheetTemplate = `<form data-task-form>
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
