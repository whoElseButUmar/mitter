export const modelSettingsTemplate = `<form class="model-settings-form"
  aria-label="Local coding model settings">
  <p class="muted">Optional local coding model. ChatGPT tasks do not need these settings.
    Choose a GGUF file already on this computer.</p>
  <fieldset class="model-settings-fields">
    <label class="field"><span>Coding model (.gguf)</span>
      <input name="coderModelPath" placeholder="/absolute/path/coder.gguf" spellcheck="false"
        maxlength="2000" autocomplete="off"></label>
    <label class="field"><span>Compute</span><select name="gpu">
      <option value="auto">Auto-detect GPU</option><option value="cpu">CPU only</option></select></label>
    <div class="form-row">
      <label class="field"><span>Context tokens</span>
        <input name="contextSize" type="number" min="2048" max="32768" step="1" required></label>
      <label class="field"><span>Output token cap</span>
        <input name="maxTokens" type="number" min="256" max="8192" step="1" required></label>
    </div>
  </fieldset>
  <p class="notice">The runtime is installed separately; no weights are downloaded automatically.
    One shared inference process generates proposals. File validation, hash checks, command approvals
    and completion checks always apply.</p>
  <p class="error" role="alert" hidden></p>
  <button class="primary full" type="submit">Save model settings</button>
  <section class="reset-danger-zone"><h3>Application data</h3>
    <p class="muted small">Permanently remove Miter’s projects, tasks, history, terminal imports,
      approvals, and settings. Your actual project folders and files stay untouched.</p>
    <button type="button" class="danger" data-reset>Clear all Miter data…</button></section>
</form>`;

export const resetTemplate = `<form class="data-reset-form">
  <p class="notice reset-warning"><strong>This permanently deletes all Miter application data from
    this computer. Your project folders and project files will not be deleted.</strong></p>
  <p>Removes all project registrations, tasks, goals and build briefs, activity, chat links and receipts,
    queues, approvals, journals, snapshots, Miter state backups, terminal imports, notification preferences,
    and model settings.</p>
  <p class="muted small">Applies to this Miter installation and Chrome profile. Running workers, local models,
    and terminal sessions will stop. Isolated Git worktree files stay in their current folders.
    ChatGPT conversations, external model files, and your operating system’s shell history
    are not deleted.</p>
  <label class="field"><span>Type exactly CLEAR to confirm</span>
    <input data-confirm aria-label="Type CLEAR to confirm" autocomplete="off" autocapitalize="off"
      spellcheck="false" maxlength="5"/></label>
  <p class="reset-connection muted small" role="status" hidden>Reconnecting to the reset coordinator.
    No reset request will be replayed.</p>
  <p class="reset-progress" role="status" aria-live="polite" hidden></p>
  <pre class="reset-failure error" role="alert" hidden></pre>
  <div class="button-row end"><button type="button" data-copy hidden>Copy error details</button>
    <button type="button" data-cancel>Cancel</button>
    <button type="submit" class="danger" data-clear disabled>Clear all Miter data</button></div>
</form>`;
