import { matchesBootstrapDraft } from '../bootstrap-draft.js';
import { composerText, findComposer } from './composer-operations.js';
import { generationActive } from './page-elements.js';
import { discoverMessages } from './transcript-discovery.js';
import type { ChatView, DomRequest } from './types.js';

function conflict(): never {
  throw Object.assign(new Error('The draft or chat changed. Miter left the current draft untouched.'), {
    code: 'DRAFT_CONFLICT',
  });
}

function emptyNativeTranscript(): boolean {
  const discovery = discoverMessages();
  const stats = discovery.stats;
  return (
    stats.state === 'empty' &&
    !stats.scanLimited &&
    !stats.unclassifiedTail &&
    discovery.messages.length === 0 &&
    stats.turnContainers === 0 &&
    stats.codeBlocks === 0 &&
    stats.roleAttributes === 0 &&
    stats.alternativeRoles === 0 &&
    stats.semanticRoles === 0
  );
}

/** Delete only the exact previously confirmed draft. This operation never sends
 * or reads provider storage; the coordinator owns completed-task authorization. */
export async function clearStaleDraft(
  request: DomRequest,
  collectView: () => Promise<ChatView>,
  checkSession: () => void,
): Promise<ChatView> {
  const proof = request.staleDraft;
  const text = request.text;
  const composer = findComposer();
  if (!proof || !text || !composer || composerText(composer) !== text) {
    conflict();
  }
  let changed = false;
  const noteChange = (): void => {
    changed = true;
  };
  composer.addEventListener('beforeinput', noteChange);
  composer.addEventListener('input', noteChange);
  try {
    const matches = await matchesBootstrapDraft(text, proof);
    checkSession();
    const checkCurrent = (): void => {
      checkSession();
      const address = new URL(location.href);
      if (
        !matches ||
        changed ||
        address.origin !== proof.origin ||
        address.pathname !== '/' ||
        address.search ||
        address.hash ||
        new URL(request.url).origin !== proof.origin ||
        findComposer() !== composer ||
        composerText(composer) !== text ||
        generationActive() ||
        !emptyNativeTranscript()
      ) {
        conflict();
      }
    };
    checkCurrent();
    composer.focus();
    checkCurrent();
    if (composer instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) {
        conflict();
      }
      setter.call(composer, '');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      selection?.removeAllRanges();
      selection?.addRange(range);
      checkCurrent();
      if (!document.execCommand('delete', false)) {
        conflict();
      }
    }
    checkSession();
    const view = await collectView();
    checkSession();
    if (view.draft || view.url !== proof.origin || findComposer() !== composer) {
      conflict();
    }
    return { ...view, outcome: 'cleared' };
  } finally {
    composer.removeEventListener('beforeinput', noteChange);
    composer.removeEventListener('input', noteChange);
  }
}
