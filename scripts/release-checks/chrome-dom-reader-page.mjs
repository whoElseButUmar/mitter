import {
  DOM_READER_URL,
  DOM_READER_LATER_USER_TEXT,
} from '../../apps/extension/test/browser/dom-reader-contracts.ts';

export const DOM_READER_POLICY =
  "default-src 'none'; script-src 'none'; connect-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'; frame-src 'self'; frame-ancestors 'none'";

export const DOM_READER_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<title>Offline Miter DOM-reader fixture</title></head><body></body></html>';

// Only the test's CDP session installs this main-world DOM builder. The actual
// reader is a packaged extension file injected separately in ISOLATED frame 0.
export const DOM_READER_PAGE_SOURCE = `(() => {
  if (location.href !== ${JSON.stringify(DOM_READER_URL)} || window !== top) {
    throw new Error('The DOM reader builder requires the exact offline top frame.');
  }
  let observer;
  let current;
  let mutations = 0;
  let clicks = 0;
  let inputs = 0;
  let frameLoaded = false;
  const clicked = () => { clicks++; };
  const input = () => { inputs++; };
  const button = (label) => {
    const control = document.createElement('button');
    control.type = 'button';
    control.setAttribute('aria-label', label);
    control.textContent = label;
    return control;
  };
  const renderTurn = (turn, index, owner = document) => {
    let element = owner.createElement('article');
    if (turn.role === 'branch') {
      element = owner.createElement('div');
    } else {
      element.setAttribute('data-testid', 'conversation-turn-' + index);
      element.setAttribute('data-message-id', turn.id);
      element.id = turn.id;
    }
    if (turn.role === 'user' || turn.role === 'assistant') {
      element.setAttribute('data-message-author-role', turn.role);
    }
    if (turn.conflict) {
      element.setAttribute('data-message-author-role', 'user');
      element.setAttribute('data-turn', 'assistant');
    }
    const body = owner.createElement('div');
    body.className = 'markdown';
    body.setAttribute('data-message-content', '');
    if (turn.code) {
      const pre = owner.createElement('pre');
      const code = owner.createElement('code');
      const split = Math.floor(turn.text.length / 2);
      for (const text of [turn.text.slice(0, split), turn.text.slice(split)]) {
        const span = owner.createElement('span');
        span.textContent = text;
        code.append(span);
      }
      pre.append(code);
      if (turn.copy) {
        pre.append(button('Copy code'));
      }
      body.append(pre);
    } else if (turn.role === 'user') {
      const pre = owner.createElement('pre');
      pre.textContent = turn.text;
      body.append(pre);
    } else {
      if (turn.text.startsWith('Thinking\\n')) {
        body.append(button('Thinking'));
        const thinking = owner.createElement('p');
        thinking.textContent = turn.text.slice('Thinking\\n'.length);
        body.append(thinking);
      } else {
        body.textContent = turn.text;
      }
    }
    element.append(body);
    if (turn.controls) {
      const actions = owner.createElement('div');
      const good = button('Good response');
      good.setAttribute('data-testid', 'good-response-turn-action-button');
      const bad = button('Bad response');
      bad.setAttribute('data-testid', 'bad-response-turn-action-button');
      actions.append(good, bad);
      element.append(actions);
    }
    if (turn.edit) {
      element.append(button('Edit message'));
    }
    return element;
  };
  const destroy = () => {
    observer?.disconnect();
    observer = undefined;
    document.body.removeEventListener('click', clicked, true);
    document.body.removeEventListener('input', input, true);
    current = undefined;
  };
  window.mitterDomReaderPage = {
    mount(plan) {
      destroy();
      current = plan;
      frameLoaded = false;
      const main = document.createElement('main');
      const transcript = document.createElement('section');
      for (const [index, turn] of plan.turns.entries()) {
        const element = renderTurn(turn, index);
        if (plan.name.startsWith('roleless-code-unanchored-') &&
            ['reader-user-current', 'reader-duplicate-prior'].includes(turn.id)) {
          const label = document.createElement('div');
          label.textContent = 'A nonmatching wrapper around the literal sent bubble.';
          element.prepend(label);
          if (plan.name === 'roleless-code-unanchored-quote') {
            const quoted = document.createElement('blockquote');
            quoted.append(element.querySelector('[data-message-content]'));
            element.append(quoted);
          }
        }
        if (plan.name === 'recovery-hidden-response' && turn.id === 'reader-response') {
          element.hidden = true;
        }
        if (plan.name === 'recovery-duplicate-known-conflicting' && turn.id === 'reader-response') {
          const conflicting = document.createElement('pre');
          const code = document.createElement('code');
          code.textContent = '{"protocol":"mitter/1","id":"reader_conflicting_reply","actions":[]}';
          conflicting.append(code);
          element.querySelector('[data-message-content]').append(conflicting);
        }
        transcript.append(element);
      }
      main.append(transcript);
      if (plan.padding) {
        const padding = document.createElement('div');
        for (let index = 0; index < plan.padding; index++) {
          padding.append(document.createElement('span'));
        }
        main.append(padding);
      }
      if (plan.frameText) {
        const inner = document.implementation.createHTMLDocument('Opaque receipt decoy');
        inner.body.append(renderTurn({
          id: 'reader-frame-decoy', role: 'user', text: plan.frameText,
          code: false, copy: false, controls: false, edit: false, conflict: false,
        }, 0, inner));
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', '');
        frame.referrerPolicy = 'no-referrer';
        frame.title = 'Opaque synthetic receipt decoy';
        frame.addEventListener('load', () => {
          frameLoaded = current === plan && frame.isConnected;
        }, { once: true });
        frame.srcdoc = '<!doctype html>' + inner.documentElement.outerHTML;
        main.append(frame);
      }
      const form = document.createElement('form');
      form.addEventListener('submit', (event) => event.preventDefault());
      const resendDraft = ['roleless-resend-draft', 'roleless-composer-only'].includes(plan.name);
      let composer = document.createElement('textarea');
      if (resendDraft) {
        composer = document.createElement('div');
        composer.setAttribute('contenteditable', 'true');
        composer.setAttribute('role', 'textbox');
        composer.textContent = plan.draft;
      } else {
        composer.value = plan.draft;
      }
      composer.id = 'prompt-textarea';
      const submit = button('Send');
      if (plan.name !== 'mixed-generating-modern-stop') {
        submit.id = 'composer-submit-button';
      }
      if (plan.generating) {
        submit.setAttribute('aria-label', 'Stop');
        submit.textContent = 'Stop';
      }
      form.append(composer, submit);
      const hiddenStop = button('Stop');
      hiddenStop.hidden = true;
      const disabledStop = button('Stop');
      disabledStop.disabled = true;
      const unavailableStop = button('Stop');
      unavailableStop.setAttribute('aria-disabled', 'true');
      form.append(hiddenStop, disabledStop, unavailableStop);
      const composerWrapper = document.createElement('div');
      composerWrapper.append(form);
      main.append(composerWrapper);
      main.append(button('Stop'));
      document.body.replaceChildren(main);
      mutations = 0;
      clicks = 0;
      inputs = 0;
      document.body.addEventListener('click', clicked, true);
      document.body.addEventListener('input', input, true);
      observer = new MutationObserver((records) => { mutations += records.length; });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    },
    editCurrentUser() {
      const body = document.querySelector('#reader-user-current [data-message-content] pre');
      if (!(body instanceof HTMLElement)) {
        throw new Error('The current synthetic user turn is missing.');
      }
      body.textContent = body.textContent.replace('Current turn.', 'Edited while digest was held.');
    },
    advanceAssistantReasoning() {
      const response = document.getElementById('reader-response');
      const transcript = response?.parentElement;
      const paragraph = response?.querySelector('[data-message-content] > p');
      const text = paragraph?.firstChild;
      if (current?.name !== 'digest-assistant-progress' || !current.generating ||
          !(response instanceof HTMLElement) || !(transcript instanceof HTMLElement) ||
          !(paragraph instanceof HTMLElement) || !(text instanceof Text) ||
          response.getAttribute('data-message-author-role') !== null) {
        throw new Error('The assistant-progress scenario requires roleless reasoning and a Stop composer.');
      }
      const elements = Array.from(transcript.querySelectorAll('*'));
      const metadata = elements.map((element) => ({
        element,
        id: element.getAttribute('data-message-id'),
        role: element.getAttribute('data-message-author-role'),
        turn: element.getAttribute('data-turn'),
      }));
      const users = current.turns.filter((turn) => turn.role === 'user').map((turn) => {
        const element = document.getElementById(turn.id);
        const body = element?.querySelector('[data-message-content]');
        if (!(element instanceof HTMLElement) || !(body instanceof HTMLElement) ||
            element.getAttribute('data-message-author-role') !== 'user' || body.textContent !== turn.text) {
          throw new Error('Assistant progress must start with unchanged full known-user bodies.');
        }
        return { element, body, turn };
      });
      const previous = text.data;
      text.data = 'Structuring the outline with a new reasoning step.';
      const refreshed = Array.from(transcript.querySelectorAll('*'));
      return text.parentNode === paragraph && text.data !== previous &&
        refreshed.length === metadata.length && metadata.every((snapshot, index) =>
          refreshed[index] === snapshot.element &&
          snapshot.element.getAttribute('data-message-id') === snapshot.id &&
          snapshot.element.getAttribute('data-message-author-role') === snapshot.role &&
          snapshot.element.getAttribute('data-turn') === snapshot.turn
        ) && users.every(({ element, body, turn }) =>
          document.getElementById(turn.id) === element && body.textContent === turn.text
        );
    },
    mutateReceiptCandidates() {
      const turn = current?.turns.find((turn) => turn.id === 'reader-user-current');
      const user = document.getElementById('reader-user-current');
      const body = user?.querySelector('[data-message-content]');
      if (!turn || !(user instanceof HTMLElement) || !(body instanceof HTMLElement) ||
          user.getAttribute('data-message-author-role') !== 'user' || body.textContent !== turn.text) {
        throw new Error('The current known user must still contain the exact original full receipt.');
      }
      switch (current.name) {
        case 'digest-duplicate-before-user': {
          const duplicate = renderTurn({
            ...turn, id: 'reader-duplicate-digest', role: 'unknown', code: true,
          }, current.turns.length);
          user.before(duplicate);
          return duplicate.isConnected && duplicate.nextElementSibling === user &&
            duplicate.querySelector('[data-message-content]')?.textContent === turn.text &&
            body.textContent === turn.text;
        }
        case 'digest-earlier-user-receipt': {
          const earlier = document.getElementById('reader-user-prior');
          const earlierBody = earlier?.querySelector('[data-message-content] pre');
          if (!(earlier instanceof HTMLElement) || !(earlierBody instanceof HTMLElement) ||
              earlier.getAttribute('data-message-author-role') !== 'user' ||
              earlier.getAttribute('data-message-id') !== 'reader-user-prior' ||
              earlierBody.textContent === turn.text) {
            throw new Error('The earlier known user must start with a different complete body.');
          }
          earlierBody.textContent = turn.text;
          return earlierBody.textContent === turn.text && body.textContent === turn.text &&
            earlier.getAttribute('data-message-id') === 'reader-user-prior' &&
            earlier.getAttribute('data-message-author-role') === 'user';
        }
        case 'digest-later-known-user': {
          const transcript = user.parentElement;
          if (!(transcript instanceof HTMLElement)) {
            throw new Error('The known user transcript is missing.');
          }
          const later = renderTurn({
            id: 'reader-user-later', role: 'user', text: ${JSON.stringify(DOM_READER_LATER_USER_TEXT)},
            code: false, copy: false, controls: false, edit: false, conflict: false,
          }, current.turns.length);
          const thinking = renderTurn({
            id: 'reader-later-thinking', role: 'unknown', text: 'Thinking\\nStructuring the outline',
            code: false, copy: false, controls: false, edit: false, conflict: false,
          }, current.turns.length + 1);
          transcript.append(later, thinking);
          return later.previousElementSibling?.id === 'reader-response' &&
            later.nextElementSibling === thinking && body.textContent === turn.text &&
            later.getAttribute('data-message-author-role') === 'user' &&
            later.querySelector('[data-message-content]')?.textContent === ${JSON.stringify(DOM_READER_LATER_USER_TEXT)};
        }
        default:
          throw new Error('This reader scenario does not mutate receipt candidates during digest.');
      }
    },
    inspect() {
      const composer = document.getElementById('prompt-textarea');
      const frame = document.querySelector('iframe');
      let frameOpaque = true;
      if (frame instanceof HTMLIFrameElement) {
        // An opaque initial about:blank is not proof that srcdoc has loaded.
        frameOpaque = frameLoaded && frame.contentDocument === null && frame.getAttribute('sandbox') === '';
      }
      return {
        mutations, clicks, inputs,
        draftExact: composer instanceof HTMLTextAreaElement
          ? composer.value === current?.draft
          : composer instanceof HTMLElement && composer.textContent === current?.draft,
        automationControls: document.querySelectorAll('#mitter-automation-control').length,
        mainWorldEndpoint: typeof globalThis.__mitterPageEndpointV4 !== 'undefined',
        frames: document.querySelectorAll('iframe').length,
        frameOpaque,
      };
    },
    destroy,
  };
})()`;
