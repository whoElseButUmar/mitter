import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { detectDevProject, startDevServer } from '../dev-server/index.js';
import { serveDevPreview } from '../preview/dev-proxy.js';
import { serveSnapshot, type PreviewServer } from '../preview/server.js';
import { snapshotApp, type PreviewSnapshot } from '../preview/snapshot.js';
import { browserExecutable } from '../quality/browser-executable.js';
import { closeBrowser, killBrowser, launchPreviewBrowser } from '../quality/browser-launch.js';
import { webAppQualityManifestSchema } from '../quality/inspect.js';
import { removeScratch } from '../quality/sandbox.js';
import { existing } from '../workspace.js';

export class WorkflowPreview {
  private readonly hostname = 'miter-' + randomBytes(16).toString('hex') + '.localhost';
  private readonly capability = randomBytes(16).toString('hex');
  private server: PreviewServer | undefined;
  private browser: Browser | undefined;
  private snapshot: PreviewSnapshot | undefined;
  private fingerprint: string | undefined;
  private readonly interrupt = () => killBrowser(this.browser);
  private readonly directory: string;
  private readonly root: string;
  private readonly signal: AbortSignal;
  private readonly chrome: string;

  private constructor(root: string, directory: string, chrome: string, signal: AbortSignal) {
    this.root = root;
    this.directory = directory;
    this.chrome = chrome;
    this.signal = signal;
    signal.addEventListener('abort', this.interrupt);
  }

  static async create(root: string, signal: AbortSignal): Promise<WorkflowPreview> {
    signal.throwIfAborted();
    const chrome = await browserExecutable();
    if (!chrome) {
      throw new Error('Install Chrome to record or run a workflow.');
    }
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'miter-workflow-')));
    const preview = new WorkflowPreview(root, directory, chrome, signal);
    try {
      if (!(await detectDevProject(root))) {
        const manifest = await existing(root, 'miter.quality.json');
        let entry = 'index.html';
        if (manifest.content !== null) {
          entry = webAppQualityManifestSchema.parse(JSON.parse(manifest.content)).entry;
        }
        preview.snapshot = await snapshotApp(root, signal, entry);
      }
      signal.throwIfAborted();
      return preview;
    } catch (error) {
      await preview.close();
      throw error;
    }
  }

  async launch(headless: boolean): Promise<{ page: Page; url: string }> {
    this.signal.throwIfAborted();
    const dataDir = path.join(this.directory, 'data');
    if (this.snapshot) {
      this.server = await serveSnapshot(this.snapshot, this.hostname, this.capability, { dataDir });
    } else {
      const runtime = await startDevServer(this.root, this.signal, 'development', undefined, dataDir);
      if (this.fingerprint && this.fingerprint !== runtime.fingerprint) {
        await runtime.close();
        throw new Error('The project changed during the workflow. Run it again against the current files.');
      }
      this.fingerprint = runtime.fingerprint;
      this.server = await serveDevPreview(runtime, this.hostname, this.capability);
    }
    this.signal.throwIfAborted();
    const profile = await fs.mkdtemp(path.join(this.directory, 'chrome-'));
    await Promise.all(['home', 'tmp'].map((dir) => fs.mkdir(path.join(profile, dir), { mode: 0o700 })));
    let url = this.server.url;
    if (this.snapshot?.entry) {
      url = new URL(this.snapshot.entry, url).href;
    }
    this.browser = await launchPreviewBrowser(this.chrome, profile, url, headless);
    this.signal.throwIfAborted();
    const initialPages = await this.browser.pages();
    const context = await this.browser.createBrowserContext({ downloadBehavior: { policy: 'deny' } });
    const page = await context.newPage();
    // Recording has a single project window in its own disposable browser.
    await Promise.all(
      initialPages.filter((initial) => initial.url() === 'about:blank').map((initial) => initial.close()),
    );
    page.setDefaultNavigationTimeout(20_000);
    page.on('popup', (popup) => void popup?.close().catch(() => {}));
    return { page, url };
  }

  async stop(): Promise<void> {
    const browser = this.browser;
    const server = this.server;
    this.browser = undefined;
    this.server = undefined;
    try {
      await closeBrowser(browser);
    } finally {
      await server?.close();
    }
  }

  async close(): Promise<void> {
    this.signal.removeEventListener('abort', this.interrupt);
    try {
      await this.stop();
    } finally {
      await removeScratch(this.directory);
    }
  }
}

export async function visitWorkflowPage(page: Page, url: string): Promise<void> {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!response?.ok() || new URL(page.url()).origin !== new URL(url).origin) {
    throw new Error('The workflow page could not open at its project preview address.');
  }
}
