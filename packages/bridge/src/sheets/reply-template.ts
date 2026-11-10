export const replySheetTemplate = `<div class="reply-sheet">
    <p class="reply-intro">Use the existing JSON reply. Your task, files and turn count stay in place.</p>
    <div class="reply-status" role="status" aria-live="polite"></div>
    <section class="reply-preview" hidden><p class="reply-task"></p><p class="reply-summary"></p><ul class="reply-actions"></ul><p class="muted small">These actions will run locally. Command approvals and file checks still apply.</p></section>
    <details class="reply-paste"><summary>Paste instead</summary><label class="field"><span>Copied Miter JSON</span><textarea class="code-input" rows="5" spellcheck="false" aria-label="Copied Miter JSON"></textarea></label><button type="button" data-reply="validate">Preview pasted reply</button></details>
    <div class="button-row reply-footer"><button type="button" data-reply="clipboard">Use copied reply</button><div class="spacer"></div><button type="button" data-reply="cancel">Cancel</button><button type="button" class="primary" data-reply="apply" disabled>Apply &amp; continue</button></div>
  </div>`;
