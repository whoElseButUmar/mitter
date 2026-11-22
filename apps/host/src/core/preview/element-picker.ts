import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, CDPSession, Page } from 'puppeteer-core';
import { z } from 'zod';
import { previewElementSchema, type PreviewElement } from '../../../../../packages/protocol/src/rpc.js';
import { browserExecutable } from '../quality/browser-executable.js';
import {
  browserNetworkArguments,
  closeBrowser,
  killBrowser,
  launchPreviewBrowser,
} from '../quality/browser-launch.js';
import { removeScratch } from '../quality/sandbox.js';
import { redact } from '../redaction.js';
import { mountElementPicker } from './element-picker-page.js';

const bounds = z
  .strictObject({
    selector: z.string().min(1).max(300),
    viewport: previewElementSchema.shape.viewport,
    pathname: z.string().max(16384),
    clip: z.strictObject({
      x: z.number().nonnegative(),
      y: z.number().nonnegative(),
      width: z.number().min(1).max(640),
      height: z.number().min(1).max(320),
    }),
  })
  .describe('Visible coordinates of the chosen element in the isolated picker document.');

function previewAddress(url: string) {
  const entry = new URL(url);
  browserNetworkArguments(entry.origin);
  if (
    entry.username ||
    entry.password ||
    !/^\/[a-f0-9]{32}\/(?:index\.html)?$/.test(entry.pathname) ||
    entry.search ||
    entry.hash
  ) {
    throw new Error('Open the current app preview before selecting an element.');
  }
  return entry;
}

function appRoute(pathname: string, entry: URL) {
  const prefix = '/' + entry.pathname.split('/')[1];
  let route = pathname;
  if (route === prefix || route.startsWith(prefix + '/')) {
    route = route.slice(prefix.length);
  }
  // Empty or ambiguous capability paths should never become clickable network addresses.
  route = '/' + route.replace(/^\/+/, '');
  route = route.replace(/%(?:3f|23).*$/i, '').replace(/[a-f0-9]{32,}/gi, '[id]');
  return redact(route).slice(0, 512);
}

async function capture(session: CDPSession, contextId: number, entry: URL): Promise<PreviewElement> {
  const selected = await session.send('Runtime.evaluate', {
    contextId,
    expression: 'globalThis.miterSelectedElement()',
    objectGroup: 'picked-element',
  });
  if (!selected.result.objectId) {
    throw new Error('The element disappeared. Select it again.');
  }
  const { node } = await session.send('DOM.describeNode', { objectId: selected.result.objectId });
  const { nodes } = await session.send('Accessibility.getPartialAXTree', {
    backendNodeId: node.backendNodeId,
    fetchRelatives: false,
  });
  const accessible = nodes.find((item) => item.backendDOMNodeId === node.backendNodeId && !item.ignored);
  let role = node.localName;
  if (typeof accessible?.role?.value === 'string') {
    role = accessible.role.value;
  }
  let name = '';
  if (typeof accessible?.name?.value === 'string') {
    name = redact(accessible.name.value)
      .replace(/(?:https?:\/\/|\/)[^\s]*\?[^\s]*/gi, '[link]')
      .replace(/[a-f0-9]{32,}/gi, '[id]')
      .slice(0, 160);
  }
  const geometry = await session.send('Runtime.evaluate', {
    contextId,
    expression: 'globalThis.miterSelectedClip()',
    returnByValue: true,
  });
  const safe = bounds.safeParse(geometry.result.value);
  if (!safe.success) {
    throw new Error('The element moved or includes private fields. Select a smaller element.');
  }
  const { clip, viewport, selector, pathname } = safe.data;
  for (const [scale, quality] of [
    [1, 75],
    [0.7, 55],
    [0.35, 40],
  ] as const) {
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality,
      clip: { ...clip, scale },
      captureBeyondViewport: false,
    });
    const screenshot = 'data:image/jpeg;base64,' + data;
    if (screenshot.length <= 80_000) {
      const current = await session.send('Runtime.evaluate', {
        contextId,
        expression: 'globalThis.miterSelectedClip()',
        returnByValue: true,
      });
      if (JSON.stringify(current.result.value) !== JSON.stringify(geometry.result.value)) {
        throw new Error('The element changed during capture. Select it again.');
      }
      return previewElementSchema.parse({
        selector,
        viewport,
        route: appRoute(pathname, entry),
        role: role.slice(0, 64),
        name,
        screenshot,
      });
    }
  }
  throw new Error('This element is too large to attach. Select a smaller area.');
}

export async function pickInPage(page: Page, url: string, signal: AbortSignal): Promise<PreviewElement> {
  signal.throwIfAborted();
  const entry = previewAddress(url);
  const session = await page.createCDPSession();
  const outcome = Promise.withResolvers<number>();
  void outcome.promise.catch(() => {});
  const cancelled = () => outcome.reject(new Error('Element selection cancelled.'));
  let contextId: number | undefined;
  const world = 'miter-picker-' + randomUUID();
  signal.addEventListener('abort', cancelled, { once: true });
  page.once('close', cancelled);
  try {
    const { frameTree } = await session.send('Page.getFrameTree');
    session.on('Runtime.executionContextCreated', ({ context }) => {
      if (context.name === world && context.auxData?.frameId === frameTree.frame.id) {
        contextId = context.id;
      }
    });
    session.on('Runtime.executionContextsCleared', () => {
      contextId = undefined;
    });
    session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
      if (executionContextId === contextId) {
        contextId = undefined;
      }
    });
    session.on('Runtime.bindingCalled', (event) => {
      if (
        event.name !== 'miterPick' ||
        contextId !== event.executionContextId ||
        new URL(page.url()).origin !== entry.origin
      ) {
        return;
      }
      if (event.payload === 'cancel') {
        cancelled();
      }
      if (event.payload === 'selected') {
        outcome.resolve(event.executionContextId);
      }
    });
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Runtime.addBinding', { name: 'miterPick', executionContextName: world });
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
      worldName: world,
      source: '(' + mountElementPicker.toString() + ')(' + JSON.stringify(entry.origin) + ')',
    });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    if (!response?.ok() || new URL(page.url()).origin !== entry.origin) {
      throw new Error('The preview could not open. Run the app and try again.');
    }
    await page.bringToFront();
    signal.throwIfAborted();
    const selectedContext = await outcome.promise;
    signal.throwIfAborted();
    if (new URL(page.url()).origin !== entry.origin || selectedContext !== contextId) {
      throw new Error('The preview navigated. Select the element again.');
    }
    return await capture(session, selectedContext, entry);
  } finally {
    signal.removeEventListener('abort', cancelled);
    page.off('close', cancelled);
    await session.detach().catch(() => {});
  }
}

export async function pickPreviewElement(url: string, signal: AbortSignal): Promise<PreviewElement> {
  previewAddress(url);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  deadline.throwIfAborted();
  const executable = await browserExecutable();
  if (!executable) {
    throw new Error('Install Chrome to select preview elements.');
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'miter-element-picker-'));
  let browser: Browser | undefined;
  const interrupt = () => killBrowser(browser);
  deadline.addEventListener('abort', interrupt, { once: true });
  try {
    await Promise.all(['home', 'tmp'].map((name) => fs.mkdir(path.join(temporary, name), { mode: 0o700 })));
    deadline.throwIfAborted();
    browser = await launchPreviewBrowser(executable, temporary, url, false);
    deadline.throwIfAborted();
    const initial = await browser.pages();
    const context = await browser.createBrowserContext({ downloadBehavior: { policy: 'deny' } });
    const page = await context.newPage();
    await page.setViewport(null);
    page.on('popup', (popup) => void popup?.close().catch(() => {}));
    await Promise.all(initial.filter((other) => other.url() === 'about:blank').map((other) => other.close()));
    return await pickInPage(page, url, deadline);
  } catch (error) {
    if (deadline.aborted) {
      throw new Error('Element selection ended. Open the picker to try again.', { cause: error });
    }
    throw error;
  } finally {
    deadline.removeEventListener('abort', interrupt);
    try {
      await closeBrowser(browser);
    } finally {
      await removeScratch(temporary);
    }
  }
}
