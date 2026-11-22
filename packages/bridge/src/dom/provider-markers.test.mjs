import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { build } from 'rolldown';
import '../runner/test-source-loader.mjs';
import { matchesReceipt, messageDigest, wrapMessage } from '../message-wire.ts';

const executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const available = await fs.access(executable).then(
  () => true,
  () => false,
);
const url = 'https://chatgpt.com/c/offline-provider-markers';
const userId = '11111111-1111-4111-8111-111111111111';
const assistantId = '22222222-2222-4222-8222-222222222222';
const exchangeId = '33333333-3333-4333-8333-333333333333';
const goal =
  'Synthetic provider marker regression\nKeep  two spaces and a tab\there.\n\n' +
  JSON.stringify({
    ok: false,
    detail: JSON.stringify({
      scope: 'Literal "quoted" content and C:\\work\\file.js.',
      findings: [
        'Request failed: https://fixture.invalid/icon.ico',
        'See [help](https://fixture.invalid/help).',
        JSON.stringify({ nested: 'Preserve \\ and "quotes" exactly.' }),
      ],
    }),
  }) +
  '\n\n\nKeep the extra blank line. 😀';
const inlineGoal = [
  goal,
  'Source excerpt:\n```js\nconst value = "keep  both spaces";\n```',
  Array.from({ length: 27 }, (_, index) => '`review/file-' + index + '.js`').join(', '),
].join('\n\n');
const reportQuoteGoal = [
  'Continue this task.',
  'BEGIN UNTRUSTED MITTER REPORT\nMITTER REPORT',
  JSON.stringify({
    ok: false,
    results: [
      {
        expected: '"constant"',
        actual: '"new value"',
        detail: JSON.stringify({ source: 'A "nested" quote.' }),
      },
    ],
  }),
  'END UNTRUSTED MITTER REPORT',
].join('\n\n');
const envelope = {
  protocol: 'mitter/1',
  id: 'provider_reply',
  workerId: 'provider_worker',
  projectId: 'provider_project',
  replyTo: exchangeId,
  actions: [
    { type: 'write', path: 'app.js', expectedHash: 'missing', content: 'const value = "  😀  ";\r\n' },
  ],
};
const replyText = '```json\n' + JSON.stringify(envelope, null, 2) + '\n```';

test(
  'real provider marker DOM preserves exact fenced replies and human-turn barriers',
  { skip: !available, timeout: 30000 },
  async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'miter-provider-markers-'));
    const bundle = await build({
      input: fileURLToPath(new URL('../chat-dom.ts', import.meta.url)),
      write: false,
      platform: 'browser',
      output: { format: 'iife', name: 'miterProviderReader' },
    });
    assert.equal(bundle.output.length, 1);
    const browser = await puppeteer.launch({
      executablePath: executable,
      headless: true,
      pipe: true,
      userDataDir: path.join(directory, 'profile'),
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--use-mock-keychain',
        '--password-store=basic',
        '--proxy-server=http://127.0.0.1:9',
      ],
    });
    context.after(async () => {
      try {
        await browser.close();
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
    await context.test(
      'selects Create image before one owned Send and preserves the rendered receipt',
      async () => {
        const page = await browser.newPage();
        try {
          await page.setRequestInterception(true);
          page.on('request', (request) => {
            if (request.url() === url) {
              void request.respond({
                status: 200,
                contentType: 'text/html',
                body: '<!doctype html><main></main>',
              });
            } else {
              void request.abort();
            }
          });
          await page.goto(url);
          await page.addScriptTag({ content: bundle.output[0].code });
          const text = 'Create a photo of a crater. Keep  two spaces. Reference 314.';
          const result = await page.evaluate(async (text) => {
            const main = document.querySelector('main');
            main.innerHTML = `
            <form>
              <div contenteditable="true" role="textbox" id="prompt-textarea"></div>
              <button type="button" data-composer-navigation-target="add-context"
                aria-label="Add files and more" aria-expanded="false">Tools</button>
              <button data-testid="send-button" type="submit">Send</button>
            </form>
            <div data-mention-section-id="chatgpt-primary" hidden>
              <button type="button" data-list-navigation-item>
                <span data-menu-row-content><span>Create image</span><span>Visualize anything</span></span>
              </button>
            </div>
          `;
            const composer = main.querySelector('#prompt-textarea');
            const picker = main.querySelector('[data-composer-navigation-target]');
            const menu = main.querySelector('[data-mention-section-id]');
            const option = menu.querySelector('button');
            const clicks = [];
            const pill = document.createElement('span');
            pill.dataset.inlineSelectionPill = '';
            pill.dataset.systemHintType = 'picture_v2';
            pill.dataset.promptLinkHref = 'chatgpt-system-hint://picture_v2';
            pill.dataset.promptLinkLabel = 'Create image';
            pill.contentEditable = 'false';
            pill.textContent = 'Create image';
            picker.addEventListener('click', () => {
              clicks.push('picker');
              picker.setAttribute('aria-expanded', 'true');
              menu.hidden = false;
            });
            option.addEventListener('click', () => {
              clicks.push('option');
              menu.hidden = true;
              picker.setAttribute('aria-expanded', 'false');
              composer.append(' ', pill);
            });
            main.querySelector('form').addEventListener('submit', (event) => {
              event.preventDefault();
              clicks.push('send');
              composer.replaceChildren();
              const sent = document.createElement('div');
              sent.dataset.userMessageBubble = 'true';
              const label = pill.cloneNode(true);
              delete label.dataset.inlineSelectionPill;
              delete label.dataset.systemHintType;
              label.dataset.layout = 'selection-pill';
              sent.append(text, ' ', label, ' ');
              main.append(sent);
            });

            const request = {
              token: 'image-mode',
              url: location.href,
              expiresAt: Date.now() + 60000,
              text,
              messageId: 'image-mode-send',
              imageMode: true,
            };
            const prepare = () => miterProviderReader.chatDom({ ...request, op: 'prepare' });
            const first = await prepare();
            const second = await prepare();
            const prepared = await prepare();
            const commit = (overrides) =>
              miterProviderReader.chatDom({
                ...request,
                op: 'commit',
                composerSession: prepared.composerSession,
                ...overrides,
              });
            const rejected = async (call) => {
              try {
                await call();
              } catch (error) {
                return error.code;
              }
            };
            const wrongMode = await rejected(() => commit({ imageMode: undefined }));
            const plain = await rejected(() =>
              miterProviderReader.chatDom({
                ...request,
                op: 'prepare',
                imageMode: undefined,
                messageId: 'wrong-mode-send',
              }),
            );
            pill.remove();
            const missingPill = await rejected(() => commit({}));
            composer.append(pill);
            const sent = await commit({});
            const duplicate = await commit({});
            const transcript = main.querySelector('[data-user-message-bubble]');
            const read = miterProviderReader.readUserMessageVariants(transcript);
            return {
              outcomes: [first.outcome, second.outcome, prepared.outcome, sent.outcome, duplicate.outcome],
              wrongMode,
              plain,
              missingPill,
              clicks,
              sentText: read.texts[0].trim(),
            };
          }, text);
          assert.deepEqual(result, {
            outcomes: ['pending', 'pending', 'prepared', 'clicked', 'already_clicked'],
            wrongMode: 'NOT_PREPARED',
            plain: 'IMAGE_MODE_CONFLICT',
            missingPill: 'IMAGE_MODE_CHANGED',
            clicks: ['picker', 'option', 'send'],
            sentText: text,
          });
        } finally {
          await page.close();
        }
      },
    );
    for (const scenario of [
      'exact',
      'later-human',
      'stream-error',
      'stream-error-later-human',
      'unknown-tail',
      'unmarked-intervention',
      'user-wrapper-prose',
      'user-wrapper-editor',
      'user-wrapper-media',
      'assistant-wrapper-prose',
      'conflicting-role',
      'hidden-decoy',
      'composer-decoy',
      'wrong-nonce',
      'collapsed-activity',
      'collapsed-activity-disclosure',
      'collapsed-activity-search',
      'collapsed-activity-search-visible',
      'collapsed-activity-search-wrong-img',
      'collapsed-activity-search-wrong-label',
      'collapsed-activity-search-extra-turn',
      'collapsed-activity-analysis',
      'collapsed-activity-analysis-disclosure',
      'collapsed-activity-analysis-two',
      'collapsed-activity-analysis-two-unmarked-output',
      'collapsed-activity-analysis-two-reordered',
      'collapsed-activity-analysis-two-extra-message',
      'collapsed-activity-analysis-two-wrong-key',
      'collapsed-activity-analysis-two-extra-final',
      'collapsed-activity-analysis-two-stale-final',
      'collapsed-activity-analysis-two-closed',
      'collapsed-activity-analysis-two-first-closed',
      'collapsed-activity-analysis-two-last-closed',
      'collapsed-activity-analysis-two-closed-extra',
      'collapsed-activity-analysis-two-closed-misordered',
      'collapsed-activity-analysis-disclosure-no-marker',
      'collapsed-activity-analysis-disclosure-sibling',
      'collapsed-activity-analysis-disclosure-extra-text',
      'collapsed-activity-analysis-disclosure-open',
      'collapsed-activity-analysis-unmarked-source',
      'collapsed-activity-analysis-unmarked-output',
      'collapsed-activity-analysis-extra-text',
      'collapsed-activity-analysis-wrong-key',
      'collapsed-activity-analysis-extra-message',
      'collapsed-activity-extra-prose',
      'collapsed-activity-document-heading',
      'inline-code',
      'inline-code-edited',
      'inline-code-missing-footer',
      'inline-code-extra-wrapper',
      'serialized-paragraphs',
      'serialized-report-quote-escapes',
      'serialized-report-quote-escapes-edited',
      'serialized-report-quote-escapes-unmarked',
      'serialized-report-quote-escapes-wrong-nonce',
      'serialized-links',
      'serialized-edited-prose',
      'serialized-edited-backslash',
      'serialized-edited-quote',
      'serialized-edited-url',
      'serialized-literal-markdown',
      'serialized-unmarked-link',
      'serialized-extra-node',
      'serialized-source-exact',
      'serialized-source-cancel-collapses',
      'serialized-source-cancel-collapses-edited',
      'serialized-source-edited',
      'serialized-source-typing',
      'serialized-source-replaced-user',
      'serialized-source-replaced-reply',
      'serialized-source-invalidated',
      'serialized-later-human',
    ]) {
      await context.test(scenario, async () => {
        const inlineCode = scenario.startsWith('inline-code');
        let payload = goal;
        if (inlineCode) {
          payload = inlineGoal;
        } else if (scenario.startsWith('serialized-report-quote-escapes')) {
          payload = reportQuoteGoal;
        }
        const userText = wrapMessage(payload, exchangeId);
        const payloadHash = await messageDigest(payload);
        const textHash = await messageDigest(userText);
        const receipt = {
          workerId: envelope.workerId,
          projectId: envelope.projectId,
          goalHash: payloadHash,
          textHash,
          renderedHash: textHash,
          payloadHash,
          composerHash: textHash,
          acknowledgedHash: textHash,
          acknowledgedUserId: userId,
          exchangeId,
          expectsReplyTo: true,
          messageId: 'provider_send',
          priorReplyIds: [],
          turn: 1,
          at: Date.now(),
        };
        const page = await browser.newPage();
        try {
          await page.setRequestInterception(true);
          page.on('request', (request) => {
            if (request.url() === url && request.resourceType() === 'document') {
              void request.respond({
                status: 200,
                contentType: 'text/html',
                body: '<!doctype html><html><head><title>Offline marker fixture</title></head><body></body></html>',
              });
            } else {
              void request.abort();
            }
          });
          await page.goto(url);
          await page.addScriptTag({ content: bundle.output[0].code });
          await page.evaluate(
            ({ scenario, userId, assistantId, userText, replyText }) => {
              const main = document.createElement('main');
              const pair = document.createElement('div');
              main.append(pair);
              const toolbar = (labels) => {
                const row = document.createElement('div');
                for (const label of labels) {
                  const button = document.createElement('button');
                  button.setAttribute('aria-label', label);
                  row.append(button);
                }
                return row;
              };
              const makeUser = (text, id) => {
                const outer = document.createElement('div');
                outer.setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-4:0:user');
                outer.setAttribute('data-chatgpt-search-message-ids', id);
                const content = document.createElement('div');
                content.setAttribute('data-content-search-unit-key', 'fallback-turn-4:0:user');
                const bubble = document.createElement('div');
                bubble.setAttribute('data-user-message-bubble', 'true');
                const paragraph = document.createElement('p');
                paragraph.textContent = text;
                bubble.append(paragraph);
                if (scenario.startsWith('inline-code')) {
                  let source = text;
                  if (scenario === 'inline-code-edited') {
                    source = text.replace('review/file-10.js', 'review/file-99.js');
                  } else if (scenario === 'inline-code-missing-footer') {
                    source = text.slice(0, text.lastIndexOf('\n\nEND MITTER EXCHANGE '));
                  }
                  const body = document.createElement('div');
                  body.className = 'text-size-chat whitespace-pre-wrap';
                  for (const part of source.split(/(`review\/file-\d+\.js`)/g)) {
                    if (!part.startsWith('`review/')) {
                      body.append(part);
                      continue;
                    }
                    const code = document.createElement('code');
                    code.textContent = part.slice(1, -1);
                    if (scenario === 'inline-code-extra-wrapper' && part === '`review/file-0.js`') {
                      const extra = document.createElement('span');
                      extra.append(code);
                      body.append(extra);
                    } else {
                      body.append(code);
                    }
                  }
                  bubble.replaceChildren(body);
                } else if (scenario.startsWith('serialized-')) {
                  let source = text;
                  if (scenario === 'serialized-edited-prose') {
                    source = source.replace('Literal', 'Changed');
                  } else if (scenario === 'serialized-report-quote-escapes-edited') {
                    source = source.replace('new value', 'other value');
                  } else if (scenario === 'serialized-report-quote-escapes-wrong-nonce') {
                    source = source.replaceAll(
                      '33333333-3333-4333-8333-333333333333',
                      '55555555-5555-4555-8555-555555555555',
                    );
                  } else if (scenario === 'serialized-edited-backslash') {
                    source = source.replace('C:', 'C:\\');
                  } else if (scenario === 'serialized-edited-quote') {
                    source = source.replace('quoted', 'quoted"');
                  } else if (scenario === 'serialized-literal-markdown') {
                    source = source.replace(
                      'https://fixture.invalid/icon.ico',
                      '[https://fixture.invalid/icon.ico](https://fixture.invalid/icon.ico)',
                    );
                  }
                  const renderer = document.createElement('div');
                  renderer.className = 'rich-text-user-turn rich-text-serialized-paragraphs';
                  renderer.setAttribute('data-markdown-text-tone', 'user-message');
                  for (const part of source.split(/(\n{2,})/)) {
                    if (/^\n{2,}$/.test(part)) {
                      const blank = document.createElement('span');
                      blank.setAttribute('data-markdown-copy', 'blank-lines');
                      blank.textContent = part.slice(1);
                      renderer.append(blank);
                      continue;
                    }
                    const block = document.createElement('p');
                    let rendered = part;
                    if (scenario.startsWith('serialized-report-quote-escapes') && part.startsWith('{"ok":')) {
                      // The first escaped quote is split across plain spans. The
                      // other quote escapes are doubled in a bare sibling text node.
                      const split = part.indexOf('\\"');
                      block.append(part.slice(0, split));
                      const slash = document.createElement('span');
                      slash.textContent = '\\';
                      const quote = document.createElement('span');
                      quote.textContent = '"';
                      if (scenario.endsWith('-unmarked')) {
                        block.append(slash.textContent, quote.textContent);
                      } else {
                        block.append(slash, quote);
                      }
                      block.append(part.slice(split + 2).replace(/\\+(?=")/g, (run) => run + run));
                    } else if (
                      scenario !== 'serialized-paragraphs' &&
                      part.includes('https://fixture.invalid/')
                    ) {
                      rendered = part
                        .replace(/\\/g, '\\\\')
                        .replace(/\]\(/g, ']\\(')
                        .replace(
                          /https:\/\/fixture\.invalid\/[a-z.]+/g,
                          (url) => '[' + url + '](' + url + ')',
                        );
                      const automaticLink = /\[(https:\/\/fixture\.invalid\/[a-z.]+)\]\(\1\)/.exec(rendered);
                      assertFixtureLink(automaticLink);
                      const before = document.createElement('span');
                      before.textContent = rendered.slice(0, automaticLink.index);
                      const link = document.createElement('a');
                      link.setAttribute('data-inline-mention-interactive', '');
                      link.setAttribute('href', automaticLink[1]);
                      link.textContent = automaticLink[1];
                      if (scenario === 'serialized-edited-url') {
                        link.setAttribute('href', 'https://fixture.invalid/changed.ico');
                      } else if (scenario === 'serialized-unmarked-link') {
                        link.removeAttribute('data-inline-mention-interactive');
                      }
                      const after = document.createElement('span');
                      after.textContent = rendered.slice(automaticLink.index + automaticLink[0].length);
                      block.append(before, link, after);
                    } else {
                      const lines = rendered.split('\n');
                      for (const [index, line] of lines.entries()) {
                        if (index > 0) {
                          block.append(document.createElement('br'));
                        }
                        const span = document.createElement('span');
                        span.textContent = line;
                        block.append(span);
                      }
                    }
                    renderer.append(block);
                  }
                  if (scenario === 'serialized-extra-node') {
                    const extra = document.createElement('aside');
                    extra.textContent = 'An unclassified addition.';
                    renderer.append(extra);
                  }
                  bubble.replaceChildren(renderer);
                }
                const less = document.createElement('button');
                less.textContent = 'Show less';
                bubble.append(less);
                const message = document.createElement('div');
                message.append(bubble, toolbar(['Copy message', 'Share prompt', 'Edit message']));
                content.append(message);
                outer.append(content);
                const user = document.createElement('div');
                const heading = document.createElement('h4');
                heading.setAttribute('data-conversation-role', 'user');
                heading.textContent = 'You said:You';
                user.append(heading, outer);
                if (scenario === 'user-wrapper-prose') {
                  const prose = document.createElement('div');
                  prose.textContent = 'Unrelated text outside the receipt bubble.';
                  user.prepend(prose);
                } else if (scenario === 'user-wrapper-editor') {
                  user.prepend(document.createElement('textarea'));
                } else if (scenario === 'user-wrapper-media') {
                  user.prepend(document.createElement('canvas'));
                }
                return user;
              };
              function assertFixtureLink(link) {
                if (!link) {
                  throw new Error('The synthetic serialized paragraph must contain an automatic link.');
                }
              }
              pair.append(makeUser(userText, userId));
              const outer = document.createElement('div');
              outer.setAttribute('data-chatgpt-selection-message-id', assistantId);
              const heading = document.createElement('h4');
              heading.setAttribute('data-conversation-role', 'assistant');
              heading.textContent = 'ChatGPT said:ChatGPT';
              outer.append(heading);
              if (scenario === 'assistant-wrapper-prose') {
                const prose = document.createElement('p');
                prose.textContent = 'Unrelated text outside the assistant message.';
                outer.append(prose);
              }
              const markdown = document.createElement('div');
              markdown.setAttribute('data-markdown-text-style', 'assistant-message');
              const response = document.createElement('div');
              response.setAttribute('data-dil-response', '');
              response.setAttribute('data-dil-message-id', assistantId);
              const paragraph = document.createElement('p');
              paragraph.setAttribute('data-d-component', 'text');
              paragraph.textContent = replyText;
              response.append(paragraph);
              if (scenario.startsWith('stream-error')) {
                paragraph.textContent = 'Error in message stream';
                const retry = document.createElement('button');
                retry.textContent = 'Retry';
                response.append(retry);
              }
              markdown.append(response);
              outer.append(markdown);
              if (scenario.startsWith('collapsed-activity')) {
                outer.setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-4:2:assistant');
                outer.setAttribute('data-content-search-unit-key', 'fallback-turn-4:2:assistant');
                for (const speaker of [pair.querySelector('h4'), heading]) {
                  speaker.removeAttribute('data-conversation-role');
                  speaker.className = 'sr-only';
                }
                const activity = document.createElement('div');
                const header = document.createElement('div');
                header.className = 'group/activity-header';
                header.textContent = 'Worked for 1m 2s';
                const toggle = document.createElement('button');
                toggle.setAttribute('aria-expanded', 'false');
                if (scenario.includes('-disclosure')) {
                  header.className = 'text-secondary';
                  header.replaceChildren();
                  toggle.type = 'button';
                  toggle.setAttribute('data-turn-disclosure-button', '');
                  const label = document.createElement('span');
                  label.textContent = 'Worked for 1m 39s';
                  toggle.append(label, document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
                  if (scenario.endsWith('-no-marker')) {
                    toggle.removeAttribute('data-turn-disclosure-button');
                  } else if (scenario.endsWith('-sibling')) {
                    header.append(document.createElement('span'));
                  } else if (scenario.endsWith('disclosure-extra-text')) {
                    header.append('An unowned message.');
                  } else if (scenario.endsWith('-open')) {
                    toggle.setAttribute('aria-expanded', 'true');
                  }
                }
                header.append(toggle);
                activity.append(header);
                for (let index = 0; index < 2; index++) {
                  const detail = document.createElement('div');
                  detail.setAttribute('data-markdown-text-style', 'assistant-message');
                  detail.hidden = true;
                  activity.append(detail);
                }
                if (scenario.startsWith('collapsed-activity-search')) {
                  main.setAttribute('data-talvt-turn-state', 'complete');
                  pair.setAttribute('data-spacing', 'activity');
                  const marker = document.createElement('span');
                  marker.hidden = true;
                  marker.setAttribute('data-chatgpt-agent-turn-start', '');
                  activity.prepend(marker);
                  const label = document.createElement('span');
                  label.id = 'search-time';
                  label.textContent = 'Worked for 11s';
                  toggle.type = 'button';
                  toggle.setAttribute('aria-labelledby', label.id);
                  header.replaceChildren(toggle, label);
                  const hidden = document.createElement('div');
                  hidden.hidden = !scenario.endsWith('-visible');
                  const details = document.createElement('div');
                  details.setAttribute('data-spacing', 'activity');
                  const summary = document.createElement('div');
                  summary.className = 'group/activity-header';
                  summary.textContent = 'Searched the web for a discovery specification';
                  const icon = document.createElement('img');
                  icon.alt = '';
                  icon.src = 'https://www.google.com/s2/favicons?domain=fixture.invalid&sz=128';
                  if (scenario.endsWith('-wrong-img')) {
                    icon.alt = 'A substantive image';
                  } else if (scenario.endsWith('-wrong-label')) {
                    toggle.setAttribute('aria-labelledby', 'someone-else');
                  } else if (scenario.endsWith('-extra-turn')) {
                    activity.append('An intervening user message.');
                  }
                  summary.prepend(icon);
                  details.append(summary);
                  hidden.append(details);
                  activity.append(hidden);
                }
                if (scenario.startsWith('collapsed-activity-analysis')) {
                  const summary = document.createElement('div');
                  summary.className = 'group/activity-header';
                  summary.hidden = true;
                  const hiddenMarkdown = document.createElement('div');
                  hiddenMarkdown.setAttribute('data-markdown-text-style', 'assistant-message');
                  const link = document.createElement('a');
                  link.textContent = 'A link from hidden analysis';
                  hiddenMarkdown.append(link);
                  summary.append(hiddenMarkdown);
                  const panel = document.createElement('div');
                  const analyzed = document.createElement('div');
                  analyzed.className = 'group/activity-header';
                  analyzed.textContent = 'Analyzed';
                  const expand = document.createElement('button');
                  expand.setAttribute('aria-expanded', 'true');
                  analyzed.append(expand);
                  const body = document.createElement('div');
                  const program = document.createElement('div');
                  const source = document.createElement('div');
                  source.setAttribute('data-code-block', 'true');
                  const toolbar = document.createElement('div');
                  toolbar.textContent = 'Python';
                  const copy = document.createElement('button');
                  copy.setAttribute('aria-label', 'Copy code');
                  toolbar.append(copy);
                  const scrollport = document.createElement('div');
                  const code = document.createElement('code');
                  code.textContent = replyText.replace('provider_reply', 'source_decoy');
                  scrollport.append(code);
                  source.append(toolbar, scrollport);
                  const stdout = document.createElement('div');
                  const box = document.createElement('div');
                  box.className = 'bg-execution-output';
                  box.textContent = 'STDOUT/STDERR';
                  const pre = document.createElement('pre');
                  pre.className = 'text-execution-output';
                  pre.tabIndex = 0;
                  pre.textContent = replyText.replace('provider_reply', 'output_decoy');
                  box.append(pre);
                  stdout.append(box);
                  program.append(source, stdout);
                  body.append(program);
                  panel.append(analyzed, body);
                  activity.append(summary, panel);
                  if (scenario.startsWith('collapsed-activity-analysis-two')) {
                    const second = panel.cloneNode(true);
                    pre.textContent = '0';
                    second.querySelector('pre').textContent = replyText;
                    activity.append(second);
                    if (scenario.includes('-closed')) {
                      const close = (tool) => {
                        const header = tool.firstElementChild;
                        const toggle = header.querySelector('button');
                        toggle.setAttribute('aria-expanded', 'false');
                        toggle.type = 'button';
                        const label = document.createElement('span');
                        label.textContent = 'Analyzed';
                        header.replaceChildren(toggle, label, document.createElement('span'));
                        tool.replaceChildren(header);
                      };
                      if (!scenario.endsWith('last-closed')) {
                        close(panel);
                      }
                      if (!scenario.endsWith('first-closed')) {
                        close(second);
                      }
                      if (scenario.endsWith('closed-extra')) {
                        second.append('Unrelated content.');
                      }
                      if (scenario.endsWith('closed-misordered')) {
                        second.firstElementChild.append(second.querySelector('button'));
                      }
                    }
                    if (scenario.endsWith('two-unmarked-output')) {
                      second.querySelector('pre').removeAttribute('tabindex');
                    } else if (scenario.endsWith('two-reordered')) {
                      second.prepend(second.lastElementChild);
                    }
                  }
                  if (scenario.endsWith('unmarked-source')) {
                    source.removeAttribute('data-code-block');
                  } else if (scenario === 'collapsed-activity-analysis-unmarked-output') {
                    pre.className = '';
                  } else if (scenario === 'collapsed-activity-analysis-extra-text') {
                    body.append('A new unmarked message.');
                  } else if (scenario.endsWith('wrong-key')) {
                    outer.setAttribute('data-content-search-unit-key', 'another:2:assistant');
                  } else if (scenario.endsWith('extra-message')) {
                    const other = document.createElement('pre');
                    other.textContent = replyText;
                    activity.append(other);
                  }
                }
                if (scenario === 'collapsed-activity-extra-prose') {
                  activity.append(document.createTextNode('Another message.'));
                } else if (scenario === 'collapsed-activity-document-heading') {
                  const article = document.createElement('blockquote');
                  outer.prepend(article);
                  article.append(heading);
                }
                pair.append(activity);
              }
              pair.append(outer);
              if (scenario === 'collapsed-activity-analysis-two-extra-final') {
                pair.append(outer.cloneNode(true));
              } else if (scenario === 'collapsed-activity-analysis-two-stale-final') {
                paragraph.textContent = replyText.replace(
                  '33333333-3333-4333-8333-333333333333',
                  '55555555-5555-4555-8555-555555555555',
                );
              }
              main.append(toolbar(['Copy', 'Read aloud', 'Share', 'More actions']));
              if (['later-human', 'serialized-later-human', 'stream-error-later-human'].includes(scenario)) {
                main.append(
                  makeUser('Wait, change the requested feature.', '44444444-4444-4444-8444-444444444444'),
                );
              } else if (scenario === 'unknown-tail') {
                const unknown = document.createElement('div');
                unknown.setAttribute('data-chatgpt-search-unit-key', 'fallback-turn-5:0:unknown');
                unknown.textContent = 'An unclassified intervening turn.';
                main.append(unknown);
              } else if (scenario === 'unmarked-intervention') {
                const intervening = document.createElement('div');
                intervening.textContent = 'A separate human intervention without known role markers.';
                pair.insertBefore(intervening, outer);
              } else if (scenario === 'conflicting-role') {
                markdown.setAttribute('data-user-message-bubble', 'true');
              } else if (scenario === 'hidden-decoy') {
                const decoy = outer.cloneNode(true);
                decoy.hidden = true;
                main.append(decoy);
              }
              const form = document.createElement('form');
              const composer = document.createElement('textarea');
              composer.id = 'prompt-textarea';
              form.append(composer);
              if (scenario === 'composer-decoy') {
                form.append(outer.cloneNode(true));
              }
              main.append(form);
              if (scenario.startsWith('serialized-source-')) {
                const scope = pair.querySelector('[data-content-search-unit-key]');
                const edit = scope.querySelector('[aria-label="Edit message"]');
                edit.type = 'button';
                globalThis.sourceClicks = [];
                edit.addEventListener('click', () => {
                  globalThis.sourceClicks.push('edit');
                  const original = [...scope.childNodes];
                  const form = document.createElement('form');
                  const editor = document.createElement('div');
                  editor.className = 'ProseMirror';
                  editor.contentEditable = 'true';
                  editor.setAttribute('role', 'textbox');
                  editor.setAttribute('aria-label', 'Edit message');
                  editor.textContent = userText;
                  if (scenario === 'serialized-source-edited') {
                    editor.textContent = userText.replace('quoted', 'qUoted');
                  }
                  const cancel = document.createElement('button');
                  cancel.type = 'button';
                  cancel.textContent = 'Cancel';
                  cancel.onclick = () => {
                    globalThis.sourceClicks.push('cancel');
                    scope.replaceChildren(...original);
                    if (scenario.startsWith('serialized-source-cancel-collapses')) {
                      const restored = scope.querySelector('[data-user-message-bubble="true"]');
                      const full = [...restored.childNodes];
                      const expand = document.createElement('button');
                      expand.type = 'button';
                      expand.textContent = 'Show more';
                      expand.onclick = () => {
                        globalThis.sourceClicks.push('expand');
                        restored.replaceChildren(...full);
                        if (scenario.endsWith('-edited')) {
                          restored.querySelector('p').append(' Changed after the editor closed.');
                        }
                      };
                      restored.replaceChildren('Collapsed message', expand);
                    }
                    if (scenario === 'serialized-source-replaced-user') {
                      scope.parentElement.setAttribute('data-chatgpt-search-message-ids', assistantId);
                    } else if (scenario === 'serialized-source-replaced-reply') {
                      paragraph.textContent = replyText.replace('provider_reply', 'other_reply');
                    }
                  };
                  const submit = document.createElement('button');
                  submit.type = 'submit';
                  submit.textContent = 'Send';
                  form.addEventListener('submit', (event) => {
                    event.preventDefault();
                    globalThis.sourceClicks.push('submit');
                  });
                  form.append(editor, cancel, submit);
                  scope.replaceChildren(form);
                  if (scenario === 'serialized-source-typing') {
                    editor.textContent = 'My edit';
                    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
                  }
                });
              }
              document.body.replaceChildren(main);
            },
            { scenario, userId, assistantId, userText, replyText },
          );
          let replyTo = exchangeId;
          if (scenario === 'wrong-nonce') {
            replyTo = '55555555-5555-4555-8555-555555555555';
          }
          const result = await page.evaluate(
            async ({ request, scenario }) => {
              const discovery = miterProviderReader.discoverMessages();
              const roles = discovery.messages.map(miterProviderReader.messageRole);
              const identities = discovery.messages.map(miterProviderReader.messageIdentity);
              const view = await miterProviderReader.chatDom(request);
              const firstUser = document.querySelector('[data-user-message-bubble="true"]');
              let userRead;
              if (firstUser) {
                if (scenario === 'serialized-source-invalidated') {
                  firstUser.querySelector('p').append(' Edited after verification.');
                }
                userRead = miterProviderReader.readUserMessageVariants(firstUser);
              }
              return {
                roles,
                identities,
                view,
                userRead,
                sourceClicks: globalThis.sourceClicks,
                editorText: document.querySelector('.ProseMirror[aria-label="Edit message"]')?.textContent,
              };
            },
            {
              scenario,
              request: {
                op: 'inspect',
                token: 'provider-fixture',
                url,
                workerId: envelope.workerId,
                projectId: envelope.projectId,
                replyTo,
                receipt,
                expiresAt: Date.now() + 30000,
              },
            },
          );
          if (scenario.startsWith('serialized-source-')) {
            const verified =
              scenario === 'serialized-source-exact' ||
              scenario === 'serialized-source-cancel-collapses' ||
              scenario === 'serialized-source-invalidated';
            assert.equal(await matchesReceipt(result.view.lastUserText, receipt), verified);
            if (scenario === 'serialized-source-typing') {
              assert.deepEqual(result.sourceClicks, ['edit']);
              assert.equal(result.editorText, 'My edit');
            } else {
              const expected = ['edit', 'cancel'];
              if (scenario.startsWith('serialized-source-cancel-collapses')) {
                expected.push('expand');
              }
              assert.deepEqual(result.sourceClicks, expected);
              assert.equal(result.editorText, undefined);
            }
            if (scenario === 'serialized-source-invalidated') {
              const matches = await Promise.all(
                result.userRead.texts.map((text) => matchesReceipt(text, receipt)),
              );
              assert.ok(
                !matches.includes(true),
                'Changing the bubble invalidates its previous source proof.',
              );
            }
          } else if (scenario.startsWith('stream-error')) {
            assert.equal(result.view.codeReply, undefined);
            if (scenario === 'stream-error') {
              assert.equal(result.view.replyRecovery?.issue, 'PROVIDER_STREAM_ERROR');
              assert.equal(result.view.replyRecovery?.userText, userText);
            } else {
              assert.equal(result.view.replyRecovery, undefined);
              assert.equal(result.view.lastRole, 'user');
            }
          } else if (inlineCode) {
            assert.equal(result.userRead.stats.codeElements, 27);
            assert.equal(result.userRead.stats.preElements, 0);
            const candidates = [result.view.lastUserText, ...(result.view.lastUserCandidates || [])];
            const matches = await Promise.all(candidates.map((text) => matchesReceipt(text, receipt)));
            if (scenario === 'inline-code') {
              assert.equal(result.userRead.texts[0].length, userText.length - 54);
              assert.equal(await matchesReceipt(result.userRead.texts[0], receipt), false);
              const verifiedText = candidates[matches.indexOf(true)];
              assert.equal(verifiedText, userText);
              assert.equal(await messageDigest(verifiedText), receipt.textHash);
              assert.equal(result.view.codeReply?.replyTo, exchangeId);
            } else {
              assert.ok(
                !matches.includes(true),
                'An edited or incomplete message must not authorize a send.',
              );
            }
          } else if (
            [
              'exact',
              'hidden-decoy',
              'composer-decoy',
              'serialized-paragraphs',
              'serialized-report-quote-escapes',
              'collapsed-activity',
              'collapsed-activity-disclosure',
              'collapsed-activity-search',
              'collapsed-activity-analysis',
              'collapsed-activity-analysis-disclosure',
              'collapsed-activity-analysis-two',
              'collapsed-activity-analysis-two-closed',
              'collapsed-activity-analysis-two-first-closed',
              'collapsed-activity-analysis-two-last-closed',
            ].includes(scenario)
          ) {
            assert.deepEqual(result.roles, ['user', 'assistant']);
            assert.deepEqual(result.identities, [userId, assistantId]);
            assert.equal(
              result.view.transcript.unclassifiedTail,
              false,
              JSON.stringify(result.view.transcript),
            );
            assert.equal(result.view.transcript.state, 'ready');
            assert.equal(result.view.complete, true);
            assert.equal(result.view.assistantId, assistantId);
            assert.equal(result.view.assistantFormat, 'code');
            assert.equal(result.view.codeReply?.replyTo, exchangeId);
            assert.deepEqual(
              JSON.parse(result.view.codeReply.text.replace(/^\s*```json\s*|\s*```\s*$/g, '')),
              envelope,
            );
            const matches = await Promise.all(
              result.userRead.texts.map((text) => matchesReceipt(text, receipt)),
            );
            assert.ok(matches.includes(true), JSON.stringify(result.userRead.stats));
            if (scenario.startsWith('collapsed-activity-analysis')) {
              assert.deepEqual(result.view.codeReplyIds, [envelope.id]);
            }
            if (scenario.startsWith('serialized-')) {
              assert.equal(
                matches[0],
                false,
                'The old paragraph reader must reproduce the receipt mismatch.',
              );
              assert.ok(
                result.userRead.texts.includes(userText),
                'The full original message must survive exactly.',
              );
            }
          } else if (scenario === 'collapsed-activity-analysis-two-stale-final') {
            assert.equal(result.view.codeReply, undefined);
            assert.equal(result.view.codeReplyIssue, 'STALE_REPLY_TO');
          } else if (scenario === 'later-human' || scenario === 'serialized-later-human') {
            assert.equal(result.view.lastRole, 'user');
            assert.equal(result.view.codeReply, undefined);
            assert.equal(result.view.codeReplyIssue, 'NEWER_USER_MESSAGE');
          } else if (scenario.startsWith('serialized-')) {
            const matches = await Promise.all(
              result.userRead.texts.map((text) => matchesReceipt(text, receipt)),
            );
            assert.equal(matches.includes(true), false, 'Edited source must not match the original receipt.');
          } else if (
            scenario === 'unknown-tail' ||
            scenario === 'unmarked-intervention' ||
            scenario.startsWith('collapsed-activity-') ||
            scenario.startsWith('user-wrapper-') ||
            scenario === 'assistant-wrapper-prose'
          ) {
            if (scenario === 'unknown-tail') {
              assert.equal(result.view.complete, false);
              assert.ok(result.view.transcript.unknownTurns > 0);
            }
            assert.equal(result.view.transcript.unclassifiedTail, true);
          } else if (scenario === 'conflicting-role') {
            assert.deepEqual(result.roles, ['user', 'unknown']);
            assert.equal(result.view.codeReply, undefined);
            assert.equal(result.view.complete, false);
          } else {
            assert.equal(result.view.codeReply, undefined);
            assert.equal(result.view.codeReplyIssue, 'STALE_REPLY_TO');
          }
        } finally {
          await page.close();
        }
      });
    }
  },
);
