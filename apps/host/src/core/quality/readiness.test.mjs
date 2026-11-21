import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReadiness, inspectReadiness } from './readiness.ts';
import { browserExecutable } from './browser-executable.ts';
import {
  coreRpcRegistry,
  parseRpcParams,
  parseRpcResult,
  readinessSchema,
} from '../../../../../packages/protocol/src/rpc.ts';

const available = {
  node: 'v26.0.0',
  platform: 'darwin',
  architecture: 'arm64',
  sandboxExecutable: true,
  browserExecutable: true,
};

test('readiness reports all web-check prerequisites without claiming any check passed', () => {
  const report = buildReadiness(available);
  assert.equal(report.webChecks.status, 'ready');
  assert.equal(report.checks.source.status, 'ready');
  assert.equal(report.checks.domain.status, 'ready');
  assert.match(report.checks.domain.detail, /Isolation is probed before each test run/);
  assert.equal(report.checks.browser.status, 'ready');
  assert.match(report.checks.browser.detail, /automatic browser journeys and Lighthouse audits/);
  assert.match(report.webChecks.detail, /prerequisites are available/);
  assert.match(report.notice, /No tests, isolation probe, browser or network request ran/);
});

test('missing Chrome blocks automatic web completion while keeping source and domain availability', () => {
  const report = buildReadiness({ ...available, browserExecutable: false });

  assert.equal(report.webChecks.status, 'unavailable');
  assert.equal(report.checks.source.status, 'ready');
  assert.equal(report.checks.domain.status, 'ready');
  assert.equal(report.checks.browser.status, 'unavailable');
  assert.equal(report.webChecks.detail, report.checks.browser.detail);
  assert.match(report.checks.browser.hint, /Install Google Chrome/);
});

test('unsupported Node and operating systems report the missing prerequisite before execution', () => {
  for (const override of [
    { node: 'v22.16.0' },
    { node: 'v25.9.0' },
    { node: 'unrecognized' },
    { platform: 'linux' },
    { platform: 'win32' },
  ]) {
    const report = buildReadiness({ ...available, ...override });
    assert.equal(report.webChecks.status, 'unavailable');
    assert.equal(report.checks.domain.status, 'unavailable');
    assert.equal(report.checks.source.status, 'ready');
    assert.equal(report.checks.browser.status, 'ready');
    assert.match(report.checks.domain.detail, /macOS sandbox-exec and Node.js 26 or newer/);
    assert.ok(report.webChecks.hint);
  }

  const missingSandbox = buildReadiness({ ...available, sandboxExecutable: false });
  assert.equal(missingSandbox.webChecks.status, 'unavailable');
  assert.match(missingSandbox.checks.domain.detail, /unavailable or not executable/);
  assert.match(missingSandbox.checks.domain.hint, /Node permissions alone are insufficient/);
});

test('readiness RPC has no mutation or caller-controlled inspection arguments', async () => {
  assert.equal(coreRpcRegistry['system.readiness'].mutation, false);
  assert.deepEqual(parseRpcParams(coreRpcRegistry, 'system.readiness', {}), {});
  assert.throws(() => parseRpcParams(coreRpcRegistry, 'system.readiness', { program: '/tmp/untrusted' }));

  const report = await inspectReadiness();
  assert.deepEqual(parseRpcResult(coreRpcRegistry, 'system.readiness', report), report);
  assert.equal(report.node, process.version);
  assert.equal(report.platform, process.platform);
  assert.equal(report.architecture, process.arch);
  const installedBrowser = await browserExecutable();
  assert.equal(report.checks.browser.status === 'ready', installedBrowser !== undefined);
  assert.equal(
    readinessSchema.safeParse({
      ...report,
      checks: { ...report.checks, browser: { status: 'ready', detail: 'Chrome is installed.' } },
    }).success,
    true,
  );
});
