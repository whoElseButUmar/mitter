import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { DOM_READER_URL } from '../../apps/extension/test/browser/dom-reader-contracts.ts';
import { parseContract, parseJsonContract } from '../helpers/runtime.mjs';
import {
  protocolMessageSchema,
  pageNavigationSchema,
  targetCloseSchema,
  previewFrameTreeSchema,
} from './chrome-schemas.mjs';
import { page, waitFor } from './chrome-ui.mjs';
import { DOM_READER_HTML, DOM_READER_POLICY } from './chrome-dom-reader-page.mjs';

const pausedRequestSchema = z
  .object({
    requestId: z.string().min(1).describe('The intercepted request to fulfill or fail.'),
    frameId: z.string().min(1).describe('Frame identity; only the owned top frame may receive the fixture.'),
    resourceType: z.string().min(1).describe('Resource kind; the fixture is only a Document.'),
    request: z
      .object({
        url: z.string().describe('Full intercepted URL, checked by exact equality.'),
        method: z.string().describe('Request method; only GET may receive the synthetic document.'),
      })
      .describe('Request identity without retaining cookies, headers, or message bodies.'),
  })
  .describe('The narrow validated portion of a CDP Fetch request event used by the offline reader check.');

/** Owns one target and a scoped Fetch-event tap on ChromePipe's actual output. */
export class DomReaderOfflinePage {
  constructor(chrome, target, frameId) {
    this.chrome = chrome;
    this.target = target;
    this.frameId = frameId;
    this.buffer = '';
    this.failure = undefined;
    this.fulfilled = 0;
    this.blocked = 0;
    this.pending = new Set();
    const output = chrome.child.stdio[4];
    if (!(output instanceof Readable)) {
      throw new Error('The offline reader check requires ChromePipe’s readable debugging pipe.');
    }
    this.output = output;
    this.receive = (chunk) => {
      try {
        this.consume(chunk);
      } catch (error) {
        this.failure ??= error;
        chrome.kill();
      }
    };
    // ChromePipe intentionally retains only diagnostics. This feature's listener
    // handles Fetch events without changing that shared transport or its logs.
    output.on('data', this.receive);
  }

  consume(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) {
      throw new Error('Offline reader debugging data exceeded the 8 MB safety limit.');
    }
    let separator = this.buffer.indexOf('\0');
    while (separator !== -1) {
      const text = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 1);
      const message = parseJsonContract(protocolMessageSchema, text, 'Invalid offline reader CDP event.');
      if (message.sessionId === this.target.session && message.method === 'Fetch.requestPaused') {
        this.schedule(message.params, false);
      } else if (message.sessionId === this.target.session && message.method === 'Fetch.authRequired') {
        this.schedule(message.params, true);
      }
      separator = this.buffer.indexOf('\0');
    }
  }

  schedule(params, authentication) {
    if (this.fulfilled + this.blocked >= 64 || this.pending.size >= 16) {
      throw new Error('Offline reader requests exceeded their bounded interception budget.');
    }
    const request = parseContract(pausedRequestSchema, params, 'Invalid offline reader Fetch request.');
    const operation = this.respond(request, authentication).catch((error) => {
      this.failure ??= error;
    });
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation));
  }

  async respond(request, authentication) {
    if (authentication) {
      this.blocked++;
      await this.chrome.request(
        'Fetch.continueWithAuth',
        { requestId: request.requestId, authChallengeResponse: { response: 'CancelAuth' } },
        this.target.session,
      );
      return;
    }
    const fixtureDocument =
      this.fulfilled === 0 &&
      request.request.url === DOM_READER_URL &&
      request.request.method === 'GET' &&
      request.resourceType === 'Document' &&
      request.frameId === this.frameId;
    if (!fixtureDocument) {
      this.blocked++;
      await this.chrome.request(
        'Fetch.failRequest',
        { requestId: request.requestId, errorReason: 'BlockedByClient' },
        this.target.session,
      );
      return;
    }
    this.fulfilled++;
    await this.chrome.request(
      'Fetch.fulfillRequest',
      {
        requestId: request.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'text/html; charset=utf-8' },
          { name: 'Content-Security-Policy', value: DOM_READER_POLICY },
          { name: 'Cache-Control', value: 'no-store' },
          { name: 'Referrer-Policy', value: 'no-referrer' },
          { name: 'X-Content-Type-Options', value: 'nosniff' },
        ],
        body: Buffer.from(DOM_READER_HTML, 'utf8').toString('base64'),
      },
      this.target.session,
    );
  }

  check() {
    if (this.failure) {
      throw new Error('The offline reader interceptor failed. No provider request was continued.', {
        cause: this.failure,
      });
    }
    assert.equal(this.fulfilled, 1, 'Exactly one offline top-frame fixture document must be fulfilled.');
  }

  async close() {
    try {
      // Never disable interception on a live supported-origin page. Close it
      // first, so even cleanup cannot accidentally continue a provider request.
      parseContract(
        targetCloseSchema,
        await this.chrome.request('Target.closeTarget', { targetId: this.target.targetId }),
        'Chrome did not close the disposable offline reader page.',
      );
    } finally {
      this.output.removeListener('data', this.receive);
      this.buffer = '';
      await Promise.allSettled([...this.pending]);
      this.pending.clear();
    }
  }
}

export async function openDomReaderOfflinePage(chrome) {
  const target = await page(chrome, 'about:blank');
  let offline;
  try {
    const tree = parseContract(
      previewFrameTreeSchema,
      await chrome.request('Page.getFrameTree', {}, target.session),
      'Chrome did not return the owned offline reader top frame.',
    );
    offline = new DomReaderOfflinePage(chrome, target, tree.frameTree.frame.id);
    await chrome.request('Network.setBypassServiceWorker', { bypass: true }, target.session);
    await chrome.request('Network.setCacheDisabled', { cacheDisabled: true }, target.session);
    await chrome.request(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: true },
      target.session,
    );
    const navigation = parseContract(
      pageNavigationSchema,
      await chrome.request('Page.navigate', { url: DOM_READER_URL }, target.session),
      'Chrome did not acknowledge the offline reader navigation.',
    );
    if (navigation.errorText !== undefined) {
      throw new Error('The intercepted offline reader navigation failed: ' + navigation.errorText);
    }
    await waitFor(
      chrome,
      target.session,
      `location.href === ${JSON.stringify(DOM_READER_URL)} && document.readyState === 'complete'`,
      'offline HTTPS reader document',
    );
    offline.check();
    return offline;
  } catch (error) {
    if (offline) {
      await offline.close();
    } else {
      await chrome.request('Target.closeTarget', { targetId: target.targetId });
    }
    throw error;
  }
}
