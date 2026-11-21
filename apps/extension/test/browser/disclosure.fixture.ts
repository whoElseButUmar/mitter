import { z } from 'zod';
import type { DomRequest } from '../../../../packages/bridge/src/chat-dom';
import type { PageTransport } from '../../../../packages/bridge/src/page-transport';

const effectsSchema = z
  .object({
    currentClicks: z.number().int().nonnegative().describe('Clicks on the current message disclosure.'),
    olderClicks: z.number().int().nonnegative().describe('Clicks on unrelated older disclosures.'),
  })
  .describe('Content-free disclosure effects in the offline fixture.');

export async function checkDisclosureRecovery(
  tabId: number,
  transport: PageTransport,
  request: DomRequest,
  userText: string,
  replyText: string,
) {
  const observations = [];
  for (const scenario of [
    'expanded_label',
    'expanded_ancestor',
    'older_ancestor',
    'collapsed',
    'expanded_aria',
  ] as const) {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      args: [scenario, userText, replyText],
      func: (name, prompt, reply) => {
        document.body.dataset.currentClicks = '0';
        document.body.dataset.olderClicks = '0';
        const main = document.createElement('main');
        const transcript = document.createElement('div');
        main.append(transcript);
        for (let index = 0; index < 2; index++) {
          const older = document.createElement('div');
          const text = document.createElement('div');
          text.textContent = 'MITTER EXCHANGE 00000000-0000-4000-8000-00000000000' + index + '\nOlder text.';
          const button = document.createElement('button');
          button.textContent = 'Show more';
          button.onclick = () => {
            document.body.dataset.olderClicks = String(Number(document.body.dataset.olderClicks) + 1);
          };
          older.append(text, button);
          transcript.append(older);
        }
        const current = document.createElement('div');
        const body = document.createElement('div');
        body.textContent = prompt;
        if (['expanded_ancestor', 'older_ancestor', 'collapsed'].includes(name)) {
          body.textContent = prompt.slice(0, 160) + '\nA displayed fragment.';
        }
        current.append(body);
        if (name !== 'older_ancestor') {
          const disclosure = document.createElement('button');
          disclosure.setAttribute('aria-label', 'Show more');
          disclosure.textContent = 'Show less';
          if (name === 'collapsed') {
            disclosure.textContent = 'Show more';
          } else if (name === 'expanded_aria') {
            disclosure.setAttribute('aria-expanded', 'true');
            disclosure.textContent = 'Show more';
          }
          disclosure.onclick = () => {
            document.body.dataset.currentClicks = String(Number(document.body.dataset.currentClicks) + 1);
            body.textContent = prompt;
            disclosure.textContent = 'Show less';
          };
          current.append(disclosure);
        }
        const assistant = document.createElement('div');
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = reply;
        pre.append(code);
        assistant.append(pre);
        transcript.append(current, assistant);
        const form = document.createElement('form');
        const composer = document.createElement('textarea');
        composer.id = 'prompt-textarea';
        form.append(composer);
        main.append(form);
        document.body.replaceChildren(main);
      },
    });
    const current = { ...request, token: crypto.randomUUID() };
    const first = await transport.request(tabId, { ...current, op: 'inspect' });
    const next = await transport.request(tabId, { ...current, op: 'inspect' });
    const effects = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      func: () => ({
        currentClicks: Number(document.body.dataset.currentClicks),
        olderClicks: Number(document.body.dataset.olderClicks),
      }),
    });
    observations.push({
      scenario,
      firstCollapsed: first.lastUserCollapsed === true,
      nextCollapsed: next.lastUserCollapsed === true,
      firstUsers: first.userCount,
      nextUsers: next.userCount,
      codeExact: next.codeReply?.text === replyText,
      ...effectsSchema.parse(effects[0]?.result),
    });
  }
  return observations;
}
