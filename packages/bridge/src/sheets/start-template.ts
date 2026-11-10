export const startSheetTemplate = `
    <p class="start-intro">Miter uses an empty chat or opens a fresh one, sends your task, and works through the replies.</p>
    <div class="start-destination"><span class="destination-dot" aria-hidden="true"></span><div><strong data-destination>New ChatGPT chat</strong><span data-destination-hint>A separate conversation for this task.</span></div></div>
    <p class="start-disclosure">Starting authorizes Miter to send this task’s prompts, code excerpts, and command results to ChatGPT until it stops. Commands still need your approval.</p>
    <details class="form-advanced start-options"><summary>Options</summary>
      <label class="field"><span>Conversation</span><select data-chat><option value="new">New ChatGPT chat</option></select></label>
      <button type="button" class="text-button" data-find>Choose an open chat…</button>
      <div class="form-row"><label class="field"><span>Turn limit</span><select data-turns><option value="8">8 turns</option><option value="15" selected>15 turns</option><option value="20">20 turns</option></select></label>
      <label class="field"><span>Time limit</span><select data-minutes><option value="15">15 minutes</option><option value="30" selected>30 minutes</option><option value="60">60 minutes</option></select></label></div>
      <p class="small muted">Stops for your draft, a different conversation, a decision, or a limit. Browser automation may conflict with the service’s terms. Redaction cannot guarantee privacy.</p>
    </details>
    <p class="error" data-error role="alert" hidden></p>
    <div class="button-row end"><button type="button" data-cancel>Cancel</button><button type="button" class="primary" data-start>Start task</button></div>`;
