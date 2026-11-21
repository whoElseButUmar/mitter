import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import lighthouse, { generateReport } from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import puppeteer, { type Browser } from 'puppeteer-core';
import { z } from 'zod';
import { isRecord } from '../types.js';
import { serveSnapshot, type PreviewServer } from '../preview/server.js';
import { serveDevPreview } from '../preview/dev-proxy.js';
import { startDevServer } from '../dev-server/index.js';
import type { PreviewSnapshot } from '../preview/snapshot.js';
import type { BrowserJourney, BrowserQualityResult } from './browser-contract.js';
import { BackendActivity } from './backend-journey.js';
import { runBrowserJourneys } from './browser-journeys.js';
import { browserExecutable } from './browser-executable.js';

export { browserExecutable } from './browser-executable.js';

const AUDIT_TIMEOUT_MS = 240_000;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_RUNS = 12;
const requiredCategories = ['performance', 'accessibility', 'best-practices', 'seo'];
const reportDirectoryPattern = /^run-\d{13}-[a-f0-9]{16}$/;
const activeReportDirectories = new Set<string>();

let auditQueue = Promise.resolve();
let reservedAudits = 0;

/** Serialize measured audits so another Miter task cannot distort their CPU timings. */
export async function reserveBrowserAudit(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  if (reservedAudits >= 32) {
    throw new Error(
      'Browser verification is busy with 32 queued tasks. Try finishing again after they complete.',
    );
  }
  const previous = auditQueue;
  let settleReservation: (() => void) | undefined;
  const reservation = new Promise<void>((resolve) => {
    settleReservation = resolve;
  });
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<void>((_resolve, reject) => {
    rejectAbort = reject;
  });
  auditQueue = previous.then(() => reservation);
  reservedAudits++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      reservedAudits--;
      settleReservation?.();
    }
  };
  const interrupt = () => rejectAbort?.(signal.reason);
  signal.addEventListener('abort', interrupt, { once: true });
  try {
    if (signal.aborted) {
      interrupt();
    }
    await Promise.race([previous, aborted]);
    signal.throwIfAborted();
    return release;
  } catch (error) {
    release();
    throw error;
  } finally {
    signal.removeEventListener('abort', interrupt);
  }
}

const lighthouseResultSchema = z
  .object({
    lighthouseVersion: z.string().min(1).describe('The Lighthouse version that generated this report.'),
    runtimeError: z
      .object({ code: z.string().optional(), message: z.string() })
      .optional()
      .describe('A Lighthouse navigation or runtime failure.'),
    categories: z
      .record(
        z.string(),
        z.object({
          score: z
            .number()
            .min(0)
            .max(1)
            .nullable()
            .describe('Lighthouse category score, or null when unscored.'),
          auditRefs: z.array(z.object({ id: z.string(), weight: z.number() })),
        }),
      )
      .describe('Every category returned by the unfiltered default Lighthouse configuration.'),
    audits: z
      .record(
        z.string(),
        z.object({
          title: z.string(),
          description: z.string(),
          score: z.number().min(0).max(1).nullable(),
          scoreDisplayMode: z.string(),
          explanation: z.string().optional(),
          displayValue: z.string().optional(),
          errorMessage: z.string().optional(),
          details: z.json().optional(),
        }),
      )
      .describe('Audit scores and bounded repair evidence; full reports retain all other details.'),
  })
  .describe('Consumed fields of a Lighthouse result validated before any passing evidence is reported.');

function firstAuditItem(details: unknown): string | undefined {
  if (!isRecord(details) || !Array.isArray(details.items)) {
    return undefined;
  }
  const item: unknown = details.items[0];
  if (!isRecord(item)) {
    return undefined;
  }
  if (typeof item.issue === 'string') {
    const issue = item.issue.slice(0, 360);
    if (typeof item.element === 'string') {
      return issue + ' (' + item.element.slice(0, 180) + ')';
    }
    return issue;
  }
  return JSON.stringify(item).slice(0, 480);
}

function missingNavigationTrace(result: z.infer<typeof lighthouseResultSchema>): boolean {
  if (
    result.runtimeError?.code !== 'NO_NAVSTART' ||
    !requiredCategories.every((name) => result.categories[name]?.auditRefs.length)
  ) {
    return false;
  }
  const traceError = (audit: { scoreDisplayMode: string; errorMessage?: string | undefined }) =>
    audit.scoreDisplayMode === 'error' && /\bNO_NAVSTART\b/.test(audit.errorMessage ?? '');
  if (
    Object.values(result.audits).some((audit) => audit.scoreDisplayMode === 'error' && !traceError(audit))
  ) {
    return false;
  }
  let missingTraceScore = false;
  for (const [name, category] of Object.entries(result.categories)) {
    if (category.score !== null && category.score < 1) {
      return false;
    }
    let affected = false;
    for (const { id, weight } of category.auditRefs) {
      if (weight <= 0) {
        continue;
      }
      const audit = result.audits[id];
      if (
        !audit ||
        (audit.scoreDisplayMode === 'binary' && audit.score === 0) ||
        (category.score === null && audit.score !== null && audit.score < 1)
      ) {
        return false;
      }
      affected ||= traceError(audit);
    }
    if (category.score === null) {
      if (!affected && requiredCategories.includes(name)) {
        return false;
      }
      missingTraceScore ||= affected;
    }
  }
  return missingTraceScore;
}

export function assessLighthouseResult(value: unknown) {
  const parsed = lighthouseResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Lighthouse returned malformed audit evidence. Inspect the retained report.', {
      cause: parsed.error,
    });
  }
  const result = parsed.data;
  const categories: Record<string, number | null> = {};
  const findings: string[] = [];
  const failedAudits = new Set<string>();

  if (result.runtimeError) {
    findings.push('Lighthouse could not complete: ' + result.runtimeError.message.slice(0, 600));
  }

  for (const required of requiredCategories) {
    const category = result.categories[required];
    if (!category || category.score === null || category.auditRefs.length === 0) {
      findings.push('Lighthouse did not return a scored ' + required + ' category.');
    }
  }

  for (const [name, category] of Object.entries(result.categories)) {
    categories[name] = null;
    if (category.score !== null) {
      categories[name] = Math.round(category.score * 100);
    }
    if (category.score !== null && category.score < 1) {
      findings.push(name + ': ' + Math.round(category.score * 100) + '/100; required 100.');
    }
    for (const reference of category.auditRefs) {
      const audit = result.audits[reference.id];
      if (
        reference.weight > 0 &&
        (!audit ||
          audit.scoreDisplayMode === 'error' ||
          (category.score !== null && category.score < 1 && audit.score !== null && audit.score < 1))
      ) {
        failedAudits.add(reference.id);
      }
    }
  }

  for (const id of failedAudits) {
    const audit = result.audits[id];
    if (!audit) {
      findings.push(id + ': the scored audit is missing from the report.');
      continue;
    }
    const detail = [
      firstAuditItem(audit.details),
      audit.errorMessage,
      audit.displayValue,
      audit.explanation,
      audit.description,
      JSON.stringify(audit.details),
    ]
      .filter(Boolean)
      .join(' ');
    findings.push(id + ': ' + audit.title + '. ' + detail.slice(0, 1800));
  }

  return {
    ok: findings.length === 0,
    categories,
    findings: findings.slice(0, 40),
    version: result.lighthouseVersion,
    missingNavigationTrace: missingNavigationTrace(result),
  };
}

export function browserNetworkArguments(origin: string): string[] {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.protocol !== 'http:' ||
    !/^miter-[a-f0-9]{32}\.localhost$/.test(url.hostname) ||
    !url.port
  ) {
    throw new Error('Browser checks require one exact owned preview origin.');
  }
  return [
    '--proxy-server=http://127.0.0.1:9',
    '--proxy-bypass-list=<-loopback>;' + url.host,
    '--host-resolver-rules=MAP ' + url.hostname + ' 127.0.0.1, MAP * ~NOTFOUND',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic',
  ];
}

function browserEnvironment(directory: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && /^(PATH|LANG|LC_[A-Z_]+|TZ)$/i.test(key)) {
      environment[key] = value;
    }
  }
  const home = path.join(directory, 'home');
  const temporary = path.join(directory, 'tmp');
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  };
}

function killBrowser(browser: Browser | undefined): void {
  const child = browser?.process();
  if (!child?.pid) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

async function closeBrowser(browser: Browser | undefined): Promise<void> {
  if (!browser) {
    return;
  }
  const timer = setTimeout(() => killBrowser(browser), 1500);
  try {
    await browser.close();
  } finally {
    clearTimeout(timer);
    killBrowser(browser);
  }
}

async function createReportDirectory(dataDir: string): Promise<string> {
  const root = path.join(dataDir, 'quality-reports');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const candidates = (await fs.readdir(root, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        reportDirectoryPattern.test(entry.name) &&
        !activeReportDirectories.has(path.join(root, entry.name)),
    )
    .map((entry) => entry.name)
    .sort();
  for (const name of candidates.slice(0, Math.max(0, candidates.length - MAX_RETAINED_RUNS + 1))) {
    await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
  const directory = path.join(root, 'run-' + Date.now() + '-' + randomBytes(8).toString('hex'));
  await fs.mkdir(directory, { mode: 0o700 });
  activeReportDirectories.add(directory);
  return directory;
}

async function saveReport(filename: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, 'utf8') > MAX_REPORT_BYTES) {
    throw new Error('A browser quality report exceeded 16 MiB; the run cannot be marked passed.');
  }
  await fs.writeFile(filename, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

type Device = 'desktop' | 'mobile';
type LighthouseObservation = { json: string; html: () => string };

export async function measureLighthouseDevice(
  device: Device,
  directory: string,
  result: BrowserQualityResult,
  allowTraceRetry: boolean,
  observe: () => Promise<LighthouseObservation>,
) {
  const measure = async (canRetry: boolean) => {
    const observed = await observe();
    let retry = false;
    try {
      const assessed = assessLighthouseResult(JSON.parse(observed.json));
      retry = canRetry && assessed.missingNavigationTrace;
      return { assessed, retry };
    } finally {
      let name = 'lighthouse-' + device;
      if (retry) {
        name += '-attempt-1';
      }
      const jsonPath = path.join(directory, name + '.json');
      const htmlPath = path.join(directory, name + '.html');
      await saveReport(jsonPath, observed.json);
      result.reports.push(jsonPath);
      await saveReport(htmlPath, observed.html());
      result.reports.push(htmlPath);
    }
  };
  const first = await measure(allowTraceRetry);
  if (!first.retry) {
    return first.assessed;
  }
  result.lighthouseRetries ??= [];
  result.lighthouseRetries.push({ device, reason: 'NO_NAVSTART' });
  return (await measure(false)).assessed;
}

async function observeLighthouse(
  browser: Browser,
  url: string,
  device: Device,
  signal: AbortSignal,
  reset: (() => Promise<void>) | undefined,
): Promise<LighthouseObservation> {
  signal.throwIfAborted();
  await reset?.();
  const context = await browser.createBrowserContext({ downloadBehavior: { policy: 'deny' } });
  try {
    const page = await context.newPage();
    let config;
    if (device === 'desktop') {
      config = desktopConfig;
    }
    const audited = await lighthouse(
      url,
      { logLevel: 'error', output: 'json', maxWaitForLoad: 30_000 },
      config,
      page,
    );
    signal.throwIfAborted();
    if (!audited) {
      throw new Error('Lighthouse did not produce a report for ' + device + '.');
    }
    return { json: JSON.stringify(audited.lhr), html: () => generateReport(audited.lhr, 'html') };
  } finally {
    await context.close();
  }
}

type FrameworkTarget = {
  root: string;
  framework: 'vite' | 'next';
  fingerprint: string;
  hasBackend?: boolean;
};
type BrowserQualityRequest = (
  | {
      snapshot: PreviewSnapshot;
      devProject?: never;
    }
  | {
      devProject: FrameworkTarget;
      snapshot?: never;
    }
) & {
  entry: string;
  journeys: BrowserJourney[];
  copyInstructions?: readonly string[];
  signal: AbortSignal;
  dataDir: string;
};

async function startFrameworkAudit(
  project: FrameworkTarget,
  mode: 'development' | 'production',
  signal: AbortSignal,
  activity: BackendActivity,
): Promise<PreviewServer> {
  const start = async () => {
    // Omitting the live project data directory gives this process a disposable store.
    const runtime = await startDevServer(project.root, signal, mode);
    try {
      signal.throwIfAborted();
      if (runtime.framework === project.framework && runtime.fingerprint === project.fingerprint) {
        return runtime;
      }
      throw new Error(
        'The framework project changed before its server was ready. Finish again to verify the current project.',
      );
    } catch (error) {
      await runtime.close();
      throw error;
    }
  };
  let audit;
  if (project.hasBackend) {
    audit = { freshRuntime: start, onBackendResponse: activity.response };
  }
  return serveDevPreview(
    await start(),
    'miter-' + randomBytes(16).toString('hex') + '.localhost',
    randomBytes(16).toString('hex'),
    undefined,
    audit,
  );
}

function launchAuditBrowser(executablePath: string, temporary: string, url: string) {
  return puppeteer.launch({
    executablePath,
    headless: true,
    ignoreDefaultArgs: ['--disable-popup-blocking'],
    pipe: true,
    userDataDir: path.join(temporary, 'profile'),
    env: browserEnvironment(temporary),
    timeout: 20_000,
    protocolTimeout: 30_000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-breakpad',
      '--use-mock-keychain',
      '--password-store=basic',
      ...browserNetworkArguments(new URL(url).origin),
    ],
  });
}

export async function runBrowserQuality(request: BrowserQualityRequest): Promise<BrowserQualityResult> {
  request.signal.throwIfAborted();
  const result: BrowserQualityResult = {
    ok: false,
    browserOk: false,
    lighthouseOk: false,
    findings: [],
    scores: [],
    reports: [],
  };
  const executablePath = await browserExecutable();
  if (!executablePath) {
    result.findings.push(
      'Chrome is not installed in a supported location. Install Google Chrome to run required browser and Lighthouse checks.',
    );
    return result;
  }
  const release = await reserveBrowserAudit(request.signal);
  const timeout = new AbortController();
  let timeoutMs = AUDIT_TIMEOUT_MS;
  if (request.devProject) {
    // Framework preparation has separate bounded install, build and readiness phases.
    // Preserve the browser budget when a cold package store takes several minutes.
    timeoutMs += 11 * 60_000;
  }
  const timer = setTimeout(
    () => timeout.abort(new Error('Browser quality checks exceeded ' + timeoutMs / 60_000 + ' minutes.')),
    timeoutMs,
  );
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  let browser: Browser | undefined;
  let server: PreviewServer | undefined;
  let temporary: string | undefined;
  let reportDirectory: string | undefined;
  const interrupt = () => killBrowser(browser);
  signal.addEventListener('abort', interrupt, { once: true });
  try {
    signal.throwIfAborted();
    const directory = await createReportDirectory(request.dataDir);
    reportDirectory = directory;
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'miter-browser-quality-'));
    await fs.mkdir(path.join(temporary, 'home'), { mode: 0o700 });
    await fs.mkdir(path.join(temporary, 'tmp'), { mode: 0o700 });
    const activity = new BackendActivity();
    let url: string;
    if (request.devProject) {
      server = await startFrameworkAudit(request.devProject, 'development', signal, activity);
      url = server.url;
    } else {
      server = await serveSnapshot(
        request.snapshot,
        'miter-' + randomBytes(16).toString('hex') + '.localhost',
        randomBytes(16).toString('hex'),
        {
          dataDir: path.join(temporary, 'backend-data'),
          ephemeral: true,
          onBackendResponse: activity.response,
        },
      );
      if (request.snapshot.backend && !server.resetBackend) {
        throw new Error('The declared backend could not be started in an isolated data directory.');
      }
      url = new URL(request.entry, server.url).href;
    }
    browser = await launchAuditBrowser(executablePath, temporary, url);
    signal.throwIfAborted();
    const journeys = await runBrowserJourneys({
      browser,
      url,
      frameworkRoutes: Boolean(request.devProject),
      copyInstructions: request.copyInstructions ?? [],
      journeys: request.journeys,
      ...(server.resetBackend && { backend: { activity, reset: server.resetBackend } }),
      reportDirectory: directory,
      signal,
    });
    if (journeys.backend) {
      result.backend = journeys.backend;
    }
    result.browserOk = journeys.ok;
    result.findings.push(...journeys.findings);
    result.reports.push(...journeys.screenshots);
    // A failing journey already requires a new snapshot. Measure both devices after that repair.
    if (journeys.ok) {
      let lighthouseOk = true;
      activity.start();
      if (request.devProject) {
        // Development tooling and HMR are part of the live journeys. Run Lighthouse on
        // the same project's production build, with its own exact-origin browser policy.
        await closeBrowser(browser);
        browser = undefined;
        await server.close();
        server = undefined;
        signal.throwIfAborted();
        server = await startFrameworkAudit(request.devProject, 'production', signal, activity);
        url = server.url;
        browser = await launchAuditBrowser(executablePath, temporary, url);
      }
      const auditBrowser = browser;
      const reset = server.resetBackend;
      for (const device of ['desktop', 'mobile'] as const) {
        const assessed = await measureLighthouseDevice(device, directory, result, journeys.ok, () =>
          observeLighthouse(auditBrowser, url, device, signal, reset),
        );
        lighthouseOk = lighthouseOk && assessed.ok;
        result.scores.push({ device, categories: assessed.categories });
        if (
          request.devProject?.framework === 'vite' &&
          assessed.findings.some(
            (finding) =>
              /^(?:robots-txt|ard-schema|llms-txt):/.test(finding) &&
              /<(?:!doctype html|html)\b/i.test(finding),
          )
        ) {
          result.findings.push(
            device +
              ' Lighthouse: A missing text or JSON resource returned the app HTML. Serve the intended public file or return a real 404 for missing assets. A Vite project without client-side routes can use appType: "mpa".',
          );
        }
        result.findings.push(...assessed.findings.map((finding) => device + ' Lighthouse: ' + finding));
      }
      result.lighthouseOk = lighthouseOk;
      result.ok = lighthouseOk;
    }
    result.findings = result.findings.slice(0, 60);
  } catch (error) {
    result.ok = false;
    result.browserOk = false;
    result.lighthouseOk = false;
    let message = String(error);
    if (error instanceof Error) {
      message = error.message;
    }
    result.findings.push('Browser verification stopped: ' + message.slice(0, 1000));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', interrupt);
    const cleanups = [closeBrowser(browser), server?.close()];
    const outcomes = await Promise.allSettled(cleanups);
    if (temporary) {
      outcomes.push(
        ...(await Promise.allSettled([fs.rm(temporary, { recursive: true, force: true, maxRetries: 3 })])),
      );
    }
    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      result.ok = false;
      result.browserOk = false;
      result.lighthouseOk = false;
      result.findings.push('Browser verification cleanup failed. Its results cannot authorize completion.');
    }
    if (reportDirectory) {
      activeReportDirectories.delete(reportDirectory);
    }
  }
  if (reportDirectory) {
    try {
      const summaryPath = path.join(reportDirectory, 'summary.json');
      result.reports.push(summaryPath);
      await saveReport(summaryPath, JSON.stringify(result, null, 2));
    } catch {
      result.ok = false;
      result.browserOk = false;
      result.lighthouseOk = false;
      result.findings.push(
        'The browser evidence summary could not be saved. Its results cannot authorize completion.',
      );
    }
  }
  release();
  request.signal.throwIfAborted();
  return result;
}
