import { z } from 'zod';
import { rawDraftDigest } from '../../../../packages/bridge/src/bootstrap-draft';
import { wrapMessage } from '../../../../packages/bridge/src/message-wire';
import type { PageTransport } from '../../../../packages/bridge/src/page-transport';
import { DOM_READER_URL } from './dom-reader-contracts';
import {
  installDomReaderDigestGate,
  inspectDomReaderDigestGate,
  releaseDomReaderDigestGate,
} from './dom-reader-digest.fixture';

export const staleDraftCases = [
  'textarea',
  'editable',
  'edited',
  'ordinary',
  'busy',
  'known_user',
  'unknown_turn',
  'draft_race',
  'navigation_race',
  'stop_race',
  'session_race',
] as const;

const resultSchema = z
  .object({
    unchanged: z.boolean().describe('The current draft retains its exact expected bytes.'),
    clicks: z.number().describe('Send button clicks observed in the disposable fixture.'),
  })
  .describe('Content-free observations of a guarded draft operation.');

/** Runs only in the already-owned, network-blocked release fixture tab. */
export async function checkStaleDraftRecovery(tabId: number, transport: PageTransport) {
  const origin = 'https://chatgpt.com';
  const exchangeId = 'a05c70de-2fa8-471d-82f0-df6cdf8b64b4';
  const text = wrapMessage('An exact completed task draft.\nKeep `source` and spaces.', exchangeId);
  const proof = {
    workerId: 'old_worker',
    projectId: 'old_project',
    exchangeId,
    origin,
    goalHash: 'a'.repeat(64),
    rawHash: await rawDraftDigest(text),
  };
  const results = [];
  try {
    for (const name of staleDraftCases) {
      let draft = text;
      if (name === 'edited') {
        draft += '\n';
      } else if (name === 'ordinary') {
        draft = 'My own unsent message.';
      }
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        args: [name, draft],
        func: (scenario, body) => {
          history.replaceState(null, '', '/');
          const form = document.createElement('form');
          form.onsubmit = (event) => event.preventDefault();
          let composer: HTMLTextAreaElement | HTMLDivElement = document.createElement('textarea');
          if (scenario === 'editable') {
            composer = document.createElement('div');
            composer.contentEditable = 'true';
            composer.textContent = body;
          } else {
            composer.value = body;
          }
          composer.id = 'prompt-textarea';
          const send = document.createElement('button');
          send.id = 'composer-submit-button';
          send.textContent = 'Send';
          send.onclick = () => {
            document.body.dataset.draftClicks = String(Number(document.body.dataset.draftClicks) + 1);
          };
          form.append(composer, send);
          document.body.replaceChildren(form);
          document.body.dataset.draftClicks = '0';
          if (scenario === 'busy') {
            const stop = document.createElement('button');
            stop.setAttribute('aria-label', 'Stop');
            form.append(stop);
          }
          if (scenario === 'known_user' || scenario === 'unknown_turn') {
            const turn = document.createElement('article');
            turn.dataset.testid = 'conversation-turn-1';
            turn.textContent = 'An existing conversation.';
            if (scenario === 'known_user') {
              turn.setAttribute('data-message-author-role', 'user');
            }
            document.body.prepend(turn);
          }
        },
      });
      const request = { token: crypto.randomUUID(), url: origin, expiresAt: Date.now() + 60000 };
      const before = await transport.request(tabId, { ...request, op: 'inspect' });
      const racing = name.endsWith('_race');
      if (racing) {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: 'ISOLATED',
          func: installDomReaderDigestGate,
        });
      }
      const pending = transport
        .request(tabId, {
          ...request,
          op: 'clear_draft',
          composerSession: before.composerSession,
          text: draft,
          staleDraft: { ...proof, origin: 'https://chatgpt.com' },
        })
        .then(
          (view) => view.outcome === 'cleared',
          () => false,
        );
      if (racing) {
        let held = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const states = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: 'ISOLATED',
            func: inspectDomReaderDigestGate,
          });
          if ((states[0]?.result?.calls ?? 0) > 0) {
            held = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        if (!held) {
          throw new Error('The stale-draft operation did not reach its digest gate.');
        }
        if (name === 'stop_race') {
          await transport.request(tabId, { ...request, op: 'stop' });
        } else if (name === 'session_race') {
          await transport.request(tabId, { ...request, token: crypto.randomUUID(), op: 'inspect' });
        } else {
          await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: 'ISOLATED',
            args: [name],
            func: (scenario) => {
              if (scenario === 'navigation_race') {
                history.replaceState(null, '', '/c/another-conversation');
              } else {
                const composer = document.getElementById('prompt-textarea');
                if (composer instanceof HTMLTextAreaElement) {
                  composer.value += ' human edit';
                  composer.dispatchEvent(new Event('input', { bubbles: true }));
                }
              }
            },
          });
        }
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: 'ISOLATED',
          func: releaseDomReaderDigestGate,
        });
      }
      const cleared = await pending;
      let expected = draft;
      if (name === 'textarea' || name === 'editable') {
        expected = '';
      } else if (name === 'draft_race') {
        expected += ' human edit';
      }
      const observed = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        args: [expected],
        func: (expectedText) => {
          const composer = document.getElementById('prompt-textarea');
          let text = composer?.textContent ?? '';
          if (composer instanceof HTMLTextAreaElement) {
            text = composer.value;
          }
          return { unchanged: text === expectedText, clicks: Number(document.body.dataset.draftClicks) };
        },
      });
      results.push({ name, cleared, ...resultSchema.parse(observed[0]?.result) });
    }
    return results;
  } finally {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      func: releaseDomReaderDigestGate,
    });
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      args: [DOM_READER_URL],
      func: (url) => history.replaceState(null, '', url),
    });
  }
}
