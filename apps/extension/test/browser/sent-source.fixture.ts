import { rawDraftDigest } from '../../../../packages/bridge/src/bootstrap-draft';
import { messageDigest, wrapMessage } from '../../../../packages/bridge/src/message-wire';
import type { PageTransport } from '../../../../packages/bridge/src/page-transport';
import { createDomReaderScenario } from './dom-reader-scenarios';

export async function inspectEditedSource(tabId: number, transport: PageTransport) {
  const { request, receipt } = await createDomReaderScenario('complete-roleless');
  const exchange = request.replyTo;
  if (!exchange) {
    throw new Error('The reader fixture requires a pending exchange.');
  }
  const link = '[Audit reference](https://example.invalid/manifest)';
  const payload = 'Read the audit report.\nError: ' + link;
  const source = wrapMessage(payload, exchange);
  const reply = JSON.stringify({
    protocol: 'mitter/1',
    id: 'read_manifest',
    replyTo: exchange,
    workerId: receipt.workerId,
    projectId: receipt.projectId,
    summary: 'Inspect the manifest.',
    actions: [{ type: 'read', path: 'manifest.json' }],
  });
  const target = { tabId, frameIds: [0] };
  await chrome.scripting.executeScript({
    target,
    world: 'ISOLATED',
    args: [source, link, reply],
    func: (original, linkText, answer) => {
      const fixture = document.createElement('div');
      fixture.innerHTML = `
        <main>
          <div data-chatgpt-search-unit-key="fallback-turn-4:0:user"
               data-chatgpt-search-message-ids="22334455-1111-4111-8111-111111111111">
            <div data-user-message-bubble="true"><div data-markdown-text-tone="user-message"
              class="rich-text-serialized-paragraphs"><p></p></div></div>
            <button type="button" aria-label="Edit message">Edit</button>
          </div>
          <div data-message-author-role="assistant" data-message-id="55667788-1111-4111-8111-111111111111">
            <pre><code></code></pre>
          </div>
        </main>
        <form><textarea id="prompt-textarea"></textarea><button type="submit" aria-label="Send">Send</button></form>`;
      document.body.replaceChildren(fixture);
      const unit = fixture.querySelector('[data-chatgpt-search-unit-key]');
      const bubble = unit?.querySelector('[data-user-message-bubble]');
      const paragraph = bubble?.querySelector('p');
      const edit = unit?.querySelector('button');
      const code = document.querySelector('pre code');
      const composer = document.querySelector('#prompt-textarea');
      if (!unit || !bubble || !paragraph || !edit || !code || !composer) {
        throw new Error('Missing fixture.');
      }
      // This presentation duplicates a link as plain text. Its frame still parses but its hash differs.
      paragraph.textContent = original.replace(linkText, linkText + linkText);
      code.textContent = answer;
      const effects = document.body.dataset;
      effects.edits = effects.cancels = effects.sends = effects.inputs = '0';
      composer.addEventListener('input', () => (effects.inputs = String(Number(effects.inputs) + 1)));
      fixture.addEventListener(
        'submit',
        (event) => {
          event.preventDefault();
          effects.sends = String(Number(effects.sends) + 1);
        },
        { capture: true },
      );
      edit.onclick = () => {
        effects.edits = String(Number(effects.edits) + 1);
        const form = document.createElement('form');
        form.innerHTML = `<div class="ProseMirror" role="textbox" contenteditable="true" aria-label="Edit message"></div>
          <button type="button">Cancel</button><button type="submit">Send</button>`;
        const editor = form.querySelector('div');
        const cancel = form.querySelector('button');
        if (!editor || !cancel) {
          throw new Error('Missing message editor.');
        }
        for (const line of original.split('\n')) {
          const paragraph = document.createElement('p');
          paragraph.textContent = line;
          editor.append(paragraph);
        }
        cancel.onclick = () => {
          effects.cancels = String(Number(effects.cancels) + 1);
          effects.sameComposer = String(composer === document.getElementById('prompt-textarea'));
          unit.replaceChildren(bubble, edit);
        };
        unit.replaceChildren(form);
      };
    },
  });
  const composerHash = await rawDraftDigest(source);
  const view = await transport.request(tabId, {
    ...request,
    receipt: {
      workerId: receipt.workerId,
      projectId: receipt.projectId,
      goalHash: receipt.goalHash,
      textHash: await messageDigest(source),
      renderedHash: await messageDigest(source),
      payloadHash: await messageDigest(payload),
      composerHash,
      exchangeId: exchange,
      expectsReplyTo: true,
      at: Date.now(),
    },
  });
  const effects = await chrome.scripting.executeScript({
    target,
    world: 'ISOLATED',
    func: () => {
      const { edits, cancels, sends, inputs, sameComposer } = document.body.dataset;
      return {
        edits: Number(edits),
        cancels: Number(cancels),
        sends: Number(sends),
        inputs: Number(inputs),
        composerPreserved: sameComposer === 'true' && document.querySelector('textarea')?.value === '',
        editorClosed: !document.querySelector('.ProseMirror[aria-label="Edit message"]'),
      };
    },
  });
  return {
    sourceHashMatched: (await rawDraftDigest(view.lastUserText)) === composerHash,
    replyMatched: view.complete && view.lastRole === 'assistant' && view.assistantText === reply,
    ...effects[0]?.result,
  };
}
