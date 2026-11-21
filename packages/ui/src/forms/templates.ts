export const modelSettingsTemplate = `<details class="form-advanced settings-advanced" data-model-advanced>
  <summary>Advanced options</summary>
  <div class="settings-advanced-content">
    <form class="model-settings-form" aria-label="Local coding model settings">
      <fieldset class="model-settings-fields">
        <legend>Local coding model</legend>
        <p class="muted small">Optional. ChatGPT tasks work without a local model.</p>
        <label class="field"><span>Model file (.gguf)</span>
          <input name="coderModelPath" placeholder="/absolute/path/coder.gguf" spellcheck="false"
            maxlength="2000" autocomplete="off" autocapitalize="none" autocorrect="off"></label>
        <p class="muted small">Use a model already on this computer. The local runtime is installed separately.</p>
        <label class="field"><span>Compute</span><select name="gpu">
          <option value="auto">Auto-detect GPU</option><option value="cpu">CPU only</option></select></label>
        <div class="form-row">
          <label class="field"><span>Context tokens</span>
            <input name="contextSize" type="number" min="2048" max="32768" step="1" required></label>
          <label class="field"><span>Output token cap</span>
            <input name="maxTokens" type="number" min="256" max="8192" step="1" required></label>
        </div>
      </fieldset>
      <p class="error" role="alert" hidden></p>
      <div class="button-row"><button class="primary" type="submit">Save model settings</button></div>
    </form>
    <details class="settings-data">
      <summary>Application data</summary>
      <p class="muted small">Permanently clear saved projects, tasks, history, approvals, imports, and settings.
        Your project folders and files stay on disk.</p>
      <button type="button" class="danger" data-reset>Clear all Miter data…</button>
    </details>
  </div>
</details>`;

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
