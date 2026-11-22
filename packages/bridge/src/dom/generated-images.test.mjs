import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { build } from 'rolldown';
import { MAX_IMAGE_BYTES } from '../../../protocol/src/schemas/image-attachments.ts';
import { messageDigest, wrapMessage } from '../message-wire.ts';
import { downloadGeneratedImage, generatedImageSource } from './generated-images.ts';

const executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const available = await fs.access(executable).then(
  () => true,
  () => false,
);
const origin = 'https://chatgpt.com';
const conversation = origin + '/c/test-generated-image';
const imageSource = origin + '/backend-api/estuary/content?id=file_original-image';
const otherSource = origin + '/backend-api/estuary/content?id=file_different-image';
const imageBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF38AAAAASUVORK5CYII=';

test('only ChatGPT file delivery URLs qualify as generated image sources', () => {
  assert.equal(generatedImageSource(imageSource, origin)?.href, imageSource);
  assert.equal(
    generatedImageSource('/backend-api/estuary/content?id=file_original-image', origin)?.href,
    imageSource,
  );
  const cdn = 'https://files.oaiusercontent.com/files/image.png?signature=example';
  assert.equal(generatedImageSource(cdn, origin)?.href, cdn);
  for (const source of [
    imageSource + '&id=file_second-image',
    imageSource + '#section',
    imageSource.replace('file_', 'account_'),
    'https://chatgpt.com/backend-api/conversations',
    'https://chatgpt.com.example.com/backend-api/estuary/content?id=file_original-image',
    'https://chatgpt.com:8443/backend-api/estuary/content?id=file_original-image',
    'https://guest@files.oaiusercontent.com/image.png',
    'https://private.example.com/image.png',
    'blob:https://chatgpt.com/33333333-3333-4333-8333-333333333333',
    'data:image/png;base64,AAAA',
  ]) {
    assert.equal(generatedImageSource(source, origin), undefined, source);
  }
});

test('image fetch omits cross-origin credentials and rejects redirects or unsupported bytes', async (context) => {
  const fetch = context.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(Buffer.from(imageBase64, 'base64'), { headers: { 'content-type': 'image/png' } }),
  );
  const source = new URL('https://files.oaiusercontent.com/files/image.png');
  const checkSession = () => {};

  assert.deepEqual(await downloadGeneratedImage(source, origin, checkSession), {
    base64: imageBase64,
    contentType: 'image/png',
  });
  const options = fetch.mock.calls[0].arguments[1];
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.mode, 'cors');

  for (const response of [
    new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    new Response('size', { headers: { 'content-type': 'image/png', 'content-length': MAX_IMAGE_BYTES + 1 } }),
    new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), { headers: { 'content-type': 'image/png' } }),
    Response.redirect(otherSource),
  ]) {
    fetch.mock.mockImplementationOnce(async () => response);
    assert.equal(await downloadGeneratedImage(source, origin, checkSession), undefined);
  }
});

test(
  'Chrome reads a generated image only from its verified task turn',
  { skip: !available, timeout: 30000 },
  async (context) => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'miter-generated-image-'));
    const bundle = await build({
      input: fileURLToPath(new URL('../chat-dom.ts', import.meta.url)),
      write: false,
      platform: 'browser',
      output: { format: 'iife', name: 'mitterImageBridge' },
    });
    const browser = await puppeteer.launch({
      executablePath: executable,
      headless: true,
      pipe: true,
      userDataDir: path.join(directory, 'profile'),
      args: [
        '--disable-background-networking',
        '--disable-sync',
        '--use-mock-keychain',
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
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (request.url() === conversation) {
        void request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><main></main>' });
      } else {
        void request.abort();
      }
    });
    await page.goto(conversation);
    await page.addScriptTag({ content: bundle.output[0].code });

    const exchangeId = '33333333-3333-4333-8333-333333333333';
    const goal = 'Generate a fixture image.';
    const userText = wrapMessage(goal, exchangeId);
    const textHash = await messageDigest(userText);
    const receipt = {
      workerId: 'image_worker',
      projectId: 'image_project',
      goalHash: await messageDigest(goal),
      textHash,
      renderedHash: textHash,
      exchangeId,
      expectsReplyTo: true,
      at: Date.now(),
    };

    const result = await page.evaluate(
      async (fixture) => {
        const calls = [];
        globalThis.fetch = async (address, options) => {
          calls.push({ address: String(address), credentials: options.credentials });
          return new Response(
            Uint8Array.from(atob(fixture.imageBase64), (char) => char.charCodeAt(0)),
            {
              headers: { 'content-type': 'image/png' },
            },
          );
        };
        const main = document.querySelector('main');
        const user = document.createElement('div');
        user.dataset.messageAuthorRole = 'user';
        user.style.whiteSpace = 'pre-wrap';
        user.textContent = fixture.userText;
        main.append(user);
        function addImage(parent, url) {
          const image = document.createElement('img');
          image.src = url;
          parent.append(image);
        }
        const assistant = document.createElement('div');
        assistant.dataset.messageAuthorRole = 'assistant';
        addImage(assistant, 'https://example.com/avatar.png');
        addImage(assistant, fixture.imageSource);
        addImage(assistant, fixture.imageSource + '&size=thumbnail');
        main.append(assistant);

        const { receipt, exchangeId } = fixture;
        const request = {
          token: 'owned-image-session',
          url: location.href,
          workerId: receipt.workerId,
          projectId: receipt.projectId,
          replyTo: exchangeId,
          receipt,
          expiresAt: Date.now() + 60000,
        };
        const inspect = await globalThis.mitterImageBridge.chatDom({ ...request, op: 'inspect' });
        const callsDuringInspect = calls.length;

        const laterUser = document.createElement('div');
        laterUser.dataset.messageAuthorRole = 'user';
        laterUser.textContent = 'A later turn in the chat';
        addImage(laterUser, fixture.otherSource);
        const laterAssistant = document.createElement('div');
        laterAssistant.dataset.messageAuthorRole = 'assistant';
        addImage(laterAssistant, fixture.otherSource);
        main.append(laterUser, laterAssistant);

        const inspectAfterLater = await globalThis.mitterImageBridge.chatDom({ ...request, op: 'inspect' });
        const read = { ...request, op: 'read_generated_image', generatedImageIndex: 1 };
        const image = await globalThis.mitterImageBridge.chatDom(read);
        const other = await globalThis.mitterImageBridge.chatDom({ ...read, generatedImageIndex: 2 });
        user.textContent += ' Modified by the user.';
        const changed = await globalThis.mitterImageBridge.chatDom(read);
        return {
          count: inspect.generatedImageCount,
          countAfterLater: inspectAfterLater.generatedImageCount ?? null,
          callsDuringInspect,
          calls,
          image: image.generatedImage,
          other: other.generatedImageIssue,
          changed: changed.generatedImageIssue,
        };
      },
      { receipt, exchangeId, userText, imageSource, otherSource, imageBase64 },
    );
    assert.deepEqual(result, {
      count: 1,
      countAfterLater: null,
      callsDuringInspect: 0,
      calls: [{ address: imageSource, credentials: 'same-origin' }],
      image: { base64: imageBase64, contentType: 'image/png' },
      other: 'missing',
      changed: 'missing',
    });

    await context.test('the isolated bridge reads a real blob from the generated preview', async () => {
      await page.reload();
      await page.evaluate(
        async ({ userText, imageBase64 }) => {
          const main = document.querySelector('main');
          main.setAttribute('data-rail-chat-transcript', 'true');
          main.innerHTML = `
            <div data-virtualized-turn>
              <div data-turn-key>
                <div data-content-search-turn-key>
                  <div data-talvt-turn-state="complete">
                    <div data-spacing="activity">
                      <div data-chatgpt-search-unit-key="fallback-turn-0:0:user"
                        data-chatgpt-search-message-ids="11111111-1111-4111-8111-111111111111">
                        <div data-content-search-unit-key="fallback-turn-0:0:user">
                          <div data-user-message-bubble="true" data-user-message-has-prompt="true"></div>
                        </div>
                      </div>
                      <div>
                        <h4>ChatGPT said:<span>ChatGPT</span></h4>
                        <div data-response-body="22222222-2222-4222-8222-222222222222"
                          data-chatgpt-search-message-ids="22222222-2222-4222-8222-222222222222">
                          <div data-testid="generated-image-gallery">
                            <div data-web-image-tile="true">
                              <button data-testid="generated-image-preview" aria-label="Generated image 1" aria-hidden="false">
                                <img id="generated" alt="Generated image 1">
                              </button>
                            </div>
                            <div data-web-image-tile="true">
                              <button data-testid="generated-image-preview" aria-label="Generated image 2" aria-hidden="true">
                                <img id="hidden" alt="Hidden image">
                              </button>
                            </div>
                            <button data-testid="generated-image-preview" aria-label="Generated image 3" aria-hidden="false">
                              <img id="outside-tile" alt="Image outside a generated tile">
                            </button>
                            <img id="unmarked" alt="Unrelated inline image">
                          </div>
                          <div data-web-image-tile="true">
                            <button data-testid="generated-image-preview" aria-label="Generated image 4" aria-hidden="false">
                              <img id="outside-gallery" alt="Image outside the generated gallery">
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>`;
          main.querySelector('[data-user-message-bubble]').textContent = userText;
          const bytes = Uint8Array.from(atob(imageBase64), (char) => char.charCodeAt(0));
          for (const image of main.querySelectorAll('img')) {
            image.src = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
            await image.decode();
          }
        },
        { userText, imageBase64 },
      );

      const isolated = page.mainFrame().isolatedRealm();
      await isolated.evaluate(bundle.output[0].code);
      const blob = await isolated.evaluate(
        async ({ receipt, exchangeId }) => {
          const request = {
            token: 'owned-blob-image-session',
            url: location.href,
            workerId: receipt.workerId,
            projectId: receipt.projectId,
            replyTo: exchangeId,
            receipt,
            expiresAt: Date.now() + 60000,
          };
          const originalFetch = globalThis.fetch;
          const fetches = [];
          globalThis.fetch = async (source, options) => {
            fetches.push({ scheme: new URL(source).protocol, credentials: options.credentials });
            return originalFetch(source, options);
          };
          const { chatDom } = globalThis.mitterImageBridge;
          const inspect = await chatDom({ ...request, op: 'inspect' });
          const count = inspect.generatedImageCount;
          const fetchesDuringInspect = fetches.length;
          const read = { ...request, op: 'read_generated_image', generatedImageIndex: 1 };
          const image = await chatDom(read);
          const unrelated = await chatDom({ ...read, generatedImageIndex: 2 });
          const heading = document.querySelector('h4');
          const headingText = heading.textContent;
          heading.textContent = 'User-provided images';
          const unrelatedResponse = await chatDom(read);
          heading.textContent = headingText;
          document.querySelector('[data-user-message-bubble]').append(' Modified by the user.');
          const changed = await chatDom(read);
          return {
            count,
            fetchesDuringInspect,
            fetches,
            image: image.generatedImage,
            unrelated: unrelated.generatedImageIssue,
            unrelatedResponse: unrelatedResponse.generatedImageIssue,
            changed: changed.generatedImageIssue,
          };
        },
        { receipt, exchangeId },
      );
      assert.deepEqual(blob, {
        count: 1,
        fetchesDuringInspect: 0,
        fetches: [{ scheme: 'blob:', credentials: 'omit' }],
        image: { base64: imageBase64, contentType: 'image/png' },
        unrelated: 'missing',
        unrelatedResponse: 'missing',
        changed: 'missing',
      });
    });
  },
);
