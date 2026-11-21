import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browserExecutable } from './browser-executable.ts';
import {
  assessLighthouseResult,
  browserNetworkArguments,
  measureLighthouseDevice,
  runBrowserQuality,
  reserveBrowserAudit,
} from './browser-runtime.ts';

function result() {
  const categories = {};
  const audits = {};
  for (const name of ['performance', 'accessibility', 'best-practices', 'seo', 'agentic-browsing']) {
    categories[name] = { score: 1, auditRefs: [{ id: name + '-audit', weight: 1 }] };
    audits[name + '-audit'] = {
      title: name,
      description: 'Measured audit.',
      score: 1,
      scoreDisplayMode: 'binary',
    };
  }
  return { lighthouseVersion: '13.6.0', categories, audits };
}

test('all default scored categories must achieve 100, including newly added categories', () => {
  const report = result();
  assert.equal(assessLighthouseResult(report).ok, true);
  report.categories['agentic-browsing'].score = 0.86;
  report.audits['agentic-browsing-audit'].score = 0;
  const assessed = assessLighthouseResult(report);
  assert.equal(assessed.ok, false);
  assert.equal(assessed.categories['agentic-browsing'], 86);
  assert.ok(assessed.findings.some((finding) => finding.includes('agentic-browsing-audit')));
});

test('a perfect displayed category does not demand mathematically perfect individual metrics', () => {
  const report = result();
  report.audits['performance-audit'].score = 0.999;
  report.audits['performance-audit'].scoreDisplayMode = 'numeric';
  assert.equal(assessLighthouseResult(report).ok, true);
});

test('missing, null and errored required audit evidence cannot pass', () => {
  for (const missing of ['performance', 'accessibility', 'best-practices', 'seo']) {
    const report = result();
    delete report.categories[missing];
    assert.equal(assessLighthouseResult(report).ok, false);
    const unscored = result();
    unscored.categories[missing].score = null;
    assert.equal(assessLighthouseResult(unscored).ok, false);
  }
  const missingAudit = result();
  delete missingAudit.audits['accessibility-audit'];
  assert.equal(assessLighthouseResult(missingAudit).ok, false);
  const failedAudit = result();
  failedAudit.audits['accessibility-audit'].scoreDisplayMode = 'error';
  failedAudit.audits['accessibility-audit'].score = null;
  assert.equal(assessLighthouseResult(failedAudit).ok, false);
  const runtimeError = result();
  runtimeError.runtimeError = { message: 'Navigation failed.' };
  assert.equal(assessLighthouseResult(runtimeError).ok, false);
  assert.throws(() => assessLighthouseResult({ categories: {} }));
});

test('Lighthouse findings keep repair selectors and documentation without expanding huge payloads', () => {
  const report = result();
  report.categories.accessibility.score = 0.95;
  report.audits['accessibility-audit'] = {
    score: 0,
    scoreDisplayMode: 'binary',
    title: 'Buttons need names',
    description: 'See https://example.test/names.',
    details: { items: [{ node: { selector: '#save' } }], padding: 'x'.repeat(10000) },
  };
  const assessed = assessLighthouseResult(report);
  const finding = assessed.findings.find((entry) => entry.includes('Buttons need names'));
  assert.match(finding, /#save/);
  assert.match(finding, /https:\/\/example.test\/names/);
  assert.ok(finding.length < 1900);
});

test('the compact repair message identifies the unavailable ARD manifest before report headings', () => {
  const report = result();
  report.categories['agentic-browsing'] = { score: 0.75, auditRefs: [{ id: 'ard-schema', weight: 1 }] };
  const element = '/.well-known/ard.json';
  const issue = 'Advertised ARD manifest location could not be loaded (HTTP status 404).';
  report.audits['ard-schema'] = {
    score: 0,
    scoreDisplayMode: 'binary',
    title: 'ARD manifest is invalid',
    description: 'See https://example.test/ard. ' + 'Manifest discovery guidance. '.repeat(20),
    details: {
      type: 'table',
      headings: [{ label: 'Report heading'.repeat(40) }],
      items: [{ element, issue }],
    },
  };

  const assessed = assessLighthouseResult(report);
  const finding = assessed.findings.find((entry) => entry.startsWith('ard-schema:'));
  const repair = ('desktop Lighthouse: ' + finding).slice(0, 700);
  assert.equal(assessed.ok, false);
  assert.ok(repair.includes(issue));
  assert.ok(repair.includes(element));
  assert.ok(finding.includes('https://example.test/ard'));
});

function noNavigationStart() {
  const report = result();
  report.runtimeError = { code: 'NO_NAVSTART', message: 'Trace did not contain a navigation.' };
  report.categories.performance.score = null;
  report.audits['performance-audit'] = {
    ...report.audits['performance-audit'],
    score: null,
    scoreDisplayMode: 'error',
    errorMessage: 'Trace recording failed (NO_NAVSTART).',
  };
  return report;
}

test('only an isolated NO_NAVSTART collection error retries and saves both attempts', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'miter-trace-retry-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const failedTrace = noNavigationStart();
  for (const next of [result(), noNavigationStart()]) {
    const evidence = { reports: [] };
    const dir = await mkdtemp(path.join(root, 'device-'));
    const queue = [failedTrace, next];
    let calls = 0;
    const assessed = await measureLighthouseDevice('desktop', dir, evidence, true, async () => {
      calls++;
      return { json: JSON.stringify(queue.shift()), html: () => '<html>Attempt ' + calls + '</html>' };
    });
    assert.equal(calls, 2);
    assert.equal(assessed.ok, !next.runtimeError);
    assert.deepEqual(evidence.lighthouseRetries, [{ device: 'desktop', reason: 'NO_NAVSTART' }]);
    assert.deepEqual(
      evidence.reports.map((file) => path.basename(file)),
      [
        'lighthouse-desktop-attempt-1.json',
        'lighthouse-desktop-attempt-1.html',
        'lighthouse-desktop.json',
        'lighthouse-desktop.html',
      ],
    );
    assert.deepEqual(JSON.parse(await readFile(evidence.reports[0], 'utf8')), failedTrace);
    assert.match(await readFile(evidence.reports[1], 'utf8'), /Attempt 1/);
    assert.deepEqual(JSON.parse(await readFile(evidence.reports[2], 'utf8')), next);
    assert.match(await readFile(evidence.reports[3], 'utf8'), /Attempt 2/);
  }
});

test('a completed score, journey failure, separate audit error or unsupported evidence cannot trigger a retry', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'miter-no-trace-retry-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const score = noNavigationStart();
  score.categories.accessibility.score = 0.99;
  const audit = noNavigationStart();
  audit.audits['accessibility-audit'].score = 0;
  const other = noNavigationStart();
  other.audits['seo-audit'].scoreDisplayMode = 'error';
  other.audits['seo-audit'].errorMessage = 'Unexpected document failure';
  const missing = noNavigationStart();
  delete missing.categories.seo;
  const foreign = noNavigationStart();
  foreign.runtimeError.code = 'PAGE_HUNG';
  for (const [report, journeysPassed] of [
    [result(), true],
    [noNavigationStart(), false],
    [score, true],
    [audit, true],
    [other, true],
    [missing, true],
    [foreign, true],
    [{ runtimeError: { code: 'NO_NAVSTART' } }, true],
  ]) {
    const evidence = { reports: [] };
    let calls = 0;
    const dir = await mkdtemp(path.join(root, 'device-'));
    const observation = measureLighthouseDevice('mobile', dir, evidence, journeysPassed, async () => {
      calls++;
      return { json: JSON.stringify(report), html: () => '<html></html>' };
    });
    if (report.categories) {
      await observation;
    } else {
      await assert.rejects(observation, /malformed audit evidence/);
    }
    assert.equal(calls, 1);
    assert.equal(evidence.lighthouseRetries, undefined);
    assert.equal(evidence.reports.length, 2);
  }
});

test('browser networking allows exactly one owned snapshot origin and blocks implicit loopback bypass', () => {
  const host = 'miter-' + 'a'.repeat(32) + '.localhost';
  const arguments_ = browserNetworkArguments('http://' + host + ':45678');
  assert.ok(arguments_.includes('--proxy-server=http://127.0.0.1:9'));
  assert.ok(arguments_.includes('--proxy-bypass-list=<-loopback>;' + host + ':45678'));
  assert.ok(arguments_.includes('--host-resolver-rules=MAP ' + host + ' 127.0.0.1, MAP * ~NOTFOUND'));
  for (const origin of [
    'http://localhost:45678',
    'http://127.0.0.1:45678',
    'https://' + host + ':45678',
    'http://' + host,
    'http://' + host + ':45678/path',
    'http://user:password@' + host + ':45678',
    'http://*.localhost:45678',
  ]) {
    assert.throws(() => browserNetworkArguments(origin));
  }
});

test('failed real Chrome journeys return repair findings before either Lighthouse audit', async (context) => {
  if (!(await browserExecutable())) {
    return context.skip('Google Chrome is unavailable.');
  }
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'miter-journey-before-lighthouse-'));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const bytes = Buffer.from(
    '<!doctype html><html lang="en"><title>Game</title><main><h1>Game</h1>' +
      '<button>Start</button></main><script>throw Error("Could not initialize board")</script></html>',
  );
  const result = await runBrowserQuality({
    snapshot: { assets: new Map([['index.html', { bytes, mime: 'text/html' }]]), bytes: bytes.length },
    entry: 'index.html',
    journeys: [
      {
        name: 'Start game',
        steps: [
          { type: 'click', selector: 'button' },
          { type: 'expect', selector: 'h1', text: 'Game' },
        ],
      },
    ],
    dataDir,
    signal: new AbortController().signal,
  });
  assert.equal(result.ok, false);
  assert.equal(result.browserOk, false);
  assert.equal(result.lighthouseOk, false);
  assert.deepEqual(result.scores, []);
  assert.ok(result.findings.some((finding) => finding.includes('Could not initialize board')));
  assert.ok(result.reports.some((filename) => filename.endsWith('summary.json')));
  assert.ok(
    !result.reports.some(
      (filename) => filename.includes('lighthouse-desktop.') || filename.includes('lighthouse-mobile.'),
    ),
  );
});

test('an already cancelled check does not start Chrome, create reports or serve a preview', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Task owner changed.'));
  await assert.rejects(
    runBrowserQuality({
      snapshot: { assets: new Map(), bytes: 0 },
      entry: 'index.html',
      journeys: [],
      signal: controller.signal,
      dataDir: '/unused/miter-must-not-write',
    }),
    /Task owner changed/,
  );
});

test('browser audits serialize and a cancelled waiter cannot start or release the active audit', async () => {
  const releaseFirst = await reserveBrowserAudit(new AbortController().signal);
  const cancelled = new AbortController();
  const second = reserveBrowserAudit(cancelled.signal);
  cancelled.abort(new Error('Waiting task stopped.'));
  await assert.rejects(second, /Waiting task stopped/);
  let thirdStarted = false;
  const third = reserveBrowserAudit(new AbortController().signal).then((release) => {
    thirdStarted = true;
    return release;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thirdStarted, false);
  releaseFirst();
  const releaseThird = await third;
  assert.equal(thirdStarted, true);
  releaseFirst();
  releaseThird();
  const releaseLast = await reserveBrowserAudit(new AbortController().signal);
  releaseLast();
});
