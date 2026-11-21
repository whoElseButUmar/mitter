import { z } from 'zod';
import type { DomRequest } from '../../../../packages/bridge/src/chat-dom';
import { PageBridgeError, type PageTransport } from '../../../../packages/bridge/src/page-transport';
import {
  installDomReaderDigestGate,
  inspectDomReaderDigestGate,
  releaseDomReaderDigestGate,
} from './dom-reader-digest.fixture';

const metricsSchema = z
  .object({
    styles: z.number().int().nonnegative().describe('Computed-style reads during one observation.'),
    clones: z.number().int().nonnegative().describe('DOM clone operations during one observation.'),
    digests: z.number().int().nonnegative().describe('WebCrypto digests during one observation.'),
  })
  .describe('Content-free reader work counters.');

declare global {
  var __mitterLongReadMetrics:
    { styles: number; clones: number; digests: number; restore(): void } | undefined;
}

export async function inspectLongTranscript(
  tabId: number,
  transport: PageTransport,
  request: DomRequest,
  userText: string,
  replyText: string,
) {
  const results = [];
  for (const scenario of ['current', 'missing', 'stopped'] as const) {
    const missing = scenario === 'missing';
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      args: [userText, replyText, missing],
      func: (prompt: string, reply: string, absent: boolean) => {
        const main = document.createElement('main');
        const addMessage = (text: string): void => {
          const row = document.createElement('div');
          let current = row;
          for (let depth = 0; depth < 14; depth++) {
            const wrapper = document.createElement('div');
            current.append(wrapper);
            current = wrapper;
          }
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          for (let offset = 0; offset < text.length; offset += 16) {
            const span = document.createElement('span');
            span.textContent = text.slice(offset, offset + 16);
            code.append(span);
          }
          pre.append(code);
          current.append(pre);
          main.append(row);
        };
        for (let index = 0; index < 10; index++) {
          addMessage('An older task report ' + index + '\n' + 'const prior = "source";\n'.repeat(1200));
          addMessage(
            JSON.stringify({
              protocol: 'mitter/1',
              id: 'older_' + index,
              workerId: 'reader_worker',
              projectId: 'reader_project',
              summary: 'Earlier source.',
              actions: [{ type: 'write', path: 'example.txt', content: 'previous source '.repeat(1000) }],
            }),
          );
        }
        if (!absent) {
          addMessage(prompt);
          addMessage(reply);
        }
        const form = document.createElement('form');
        const composer = document.createElement('textarea');
        composer.id = 'prompt-textarea';
        form.append(composer);
        main.append(form);
        document.body.replaceChildren(main);
        const style = window.getComputedStyle;
        const clone = Node.prototype.cloneNode;
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        const digestDescriptor = Object.getOwnPropertyDescriptor(crypto.subtle, 'digest');
        const metrics = {
          styles: 0,
          clones: 0,
          digests: 0,
          restore: () => {
            window.getComputedStyle = style;
            Node.prototype.cloneNode = clone;
            if (digestDescriptor) {
              Object.defineProperty(crypto.subtle, 'digest', digestDescriptor);
            } else {
              Reflect.deleteProperty(crypto.subtle, 'digest');
            }
            Reflect.deleteProperty(globalThis, '__mitterLongReadMetrics');
          },
        };
        window.getComputedStyle = function (element, pseudo) {
          metrics.styles++;
          return style(element, pseudo);
        };
        Node.prototype.cloneNode = function (deep) {
          metrics.clones++;
          return clone.call(this, deep);
        };
        Object.defineProperty(crypto.subtle, 'digest', {
          configurable: true,
          value: (algorithm: AlgorithmIdentifier, data: BufferSource) => {
            metrics.digests++;
            return digest(algorithm, data);
          },
        });
        globalThis.__mitterLongReadMetrics = metrics;
      },
    });
    if (scenario === 'stopped') {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        func: installDomReaderDigestGate,
      });
    }
    const started = performance.now();
    const pending = transport.request(tabId, { ...request, op: 'inspect' }).then(
      (view) => ({ matched: view.codeReply?.text === replyText, issue: view.codeReplyIssue ?? '' }),
      (error: unknown) => {
        let issue = 'error';
        if (error instanceof PageBridgeError) {
          issue = error.code;
        }
        return { matched: false, issue };
      },
    );
    let clonesBeforeStop: number | undefined;
    if (scenario === 'stopped') {
      try {
        let held = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const gates = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: 'ISOLATED',
            func: inspectDomReaderDigestGate,
          });
          if ((gates[0]?.result?.calls ?? 0) > 0) {
            held = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        if (!held) {
          throw new Error('The long receipt read did not reach its digest gate.');
        }
        const counters = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: 'ISOLATED',
          func: () => globalThis.__mitterLongReadMetrics?.clones,
        });
        clonesBeforeStop = z.number().int().nonnegative().parse(counters[0]?.result);
        await transport.request(tabId, { ...request, op: 'stop' });
      } finally {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: 'ISOLATED',
          func: releaseDomReaderDigestGate,
        });
      }
    }
    const result = await pending;
    const elapsedMs = Math.round(performance.now() - started);
    const reads = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      func: () => {
        const metrics = globalThis.__mitterLongReadMetrics;
        if (!metrics) {
          throw new Error('Missing long-transcript metrics.');
        }
        const counts = { styles: metrics.styles, clones: metrics.clones, digests: metrics.digests };
        metrics.restore();
        return counts;
      },
    });
    const metrics = metricsSchema.parse(reads[0]?.result);
    results.push({
      scenario,
      elapsedMs,
      ...result,
      ...metrics,
      retiredWithoutRead: clonesBeforeStop === undefined || clonesBeforeStop === metrics.clones,
    });
  }
  return results;
}
