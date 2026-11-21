import './host-source-loader.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { inspectInstallation, installationReady, parseDoctorArguments } from '../doctor.mjs';
import { buildVerificationSchema } from '../build/contracts.mjs';
import { parseJsonContract } from '../helpers/runtime.mjs';
import {
  installationReportSchema,
  requireNativeTerminalSchema,
  terminalReportSchema,
} from '../diagnostics/contracts.mjs';

const runtime = await import('../../apps/host/src/core/pty-runtime.js');
const nativeTerminalCheckSchema = requireNativeTerminalSchema(runtime);
test('terminal preflight reports a stale build instead of trusting an absent schema', () => {
  assert.throws(() => {
    requireNativeTerminalSchema({});
  }, /Run pnpm build:host/);
  assert.throws(() => {
    requireNativeTerminalSchema({ nativeTerminalCheckSchema: { parse() {} } });
  }, /schema is missing/);
  assert.equal(requireNativeTerminalSchema(runtime), runtime.nativeTerminalCheckSchema);
});

const identity = {
  name: 'Mitter',
  key: 'YWJj',
  extensionId: 'mclgchkiejnomabbnglaodgnmfhhipep',
  nativeHost: 'ai.mitter.host',
};

test('installation diagnostics validate JSON and leave source-only fixtures untouched', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mitter-doctor-'));

  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, 'brand'));
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: 'mitter',
      version: '1.0.0-rc.27',
      packageManager: 'pnpm@12.10.1',
      mitter: { modelRuntimes: { 'node-llama-cpp': '3.22.1' } },
    }),
  );
  await writeFile(path.join(directory, 'brand/extension-identity.json'), JSON.stringify(identity));
  const before = await readdir(directory, { recursive: true });
  const report = await inspectInstallation(directory, {
    home: directory,
    nodeVersion: '22.16.0',
    platform: 'linux',
  });

  assert.equal(report.networkRequested, false);
  assert.equal(report.projectFilesChanged, false);
  assert.equal(report.checks[0].status, 'not-built');
  assert.equal(installationReady(report), false);
  assert.equal(
    report.checks.find((check) => {
      return check.name === 'node-runtime';
    }).status,
    'failed',
  );
  assert.equal(
    report.checks.find((check) => {
      return check.name === 'automatic-app-checks';
    }).status,
    'failed',
  );
  assert.equal(
    report.checks.find((check) => {
      return check.name === 'native-registration';
    }).status,
    'failed',
  );
  assert.equal(
    report.assets.some((asset) => {
      return asset.file === 'pnpm-lock.yaml';
    }),
    false,
  );
  assert.deepEqual(await readdir(directory, { recursive: true }), before);
  assert.equal(installationReportSchema.safeParse({ ...report, networkRequested: true }).success, false);
  assert.equal(installationReportSchema.safeParse({ ...report, projectFilesChanged: true }).success, false);

  await writeFile(
    path.join(directory, 'brand/extension-identity.json'),
    JSON.stringify({
      ...identity,
      extensionId: 'invalid',
    }),
  );
  await assert.rejects(inspectInstallation(directory), /extensionId/);
});

test('terminal report uses the actual host runtime schema and declares read-only behavior', () => {
  const check = nativeTerminalCheckSchema.parse({
    version: '1.1.0',
    platform: 'darwin',
    architecture: 'arm64',
    helper: {
      helper: '/fixture/node-pty/prebuilds/darwin-arm64/spawn-helper',
      binding: '/fixture/node-pty/prebuilds/darwin-arm64/pty.node',
      modeBefore: '755',
      modeAfter: '755',
      sha256: 'a'.repeat(64),
      repaired: false,
      sharedInode: false,
      architecture: 'arm64',
    },
  });
  const report = {
    node: process.version,
    platform: check.platform,
    architecture: check.architecture,
    installation: '/fixture',
    checks: [
      {
        name: 'native-terminal-runtime',
        status: 'passed',
        ...check,
      },
    ],
    modifiedFiles: false,
    spawnedProcesses: false,
    guidance: 'Read-only prerequisites.',
  };
  const schema = terminalReportSchema(nativeTerminalCheckSchema);

  assert.deepEqual(schema.parse(report), report);
  assert.deepEqual(terminalReportSchema(nativeTerminalCheckSchema.strict()).parse(report), report);
  const refinedSchema = terminalReportSchema(
    nativeTerminalCheckSchema.refine((check) => {
      return check.architecture === 'arm64';
    }),
  );
  assert.deepEqual(refinedSchema.parse(report), report);
  assert.equal(
    refinedSchema.safeParse({
      ...report,
      checks: [
        {
          ...report.checks[0],
          architecture: 'x64',
          helper: { ...check.helper, architecture: 'x64' },
        },
      ],
    }).success,
    false,
  );
  assert.equal(schema.safeParse({ ...report, modifiedFiles: true }).success, false);
  assert.equal(schema.safeParse({ ...report, spawnedProcesses: true }).success, false);
  assert.equal(
    schema.safeParse({
      ...report,
      checks: [{ ...report.checks[0], helper: {} }],
    }).success,
    false,
  );
  assert.equal(terminalReportSchema().safeParse(report).success, false);

  for (const changes of [
    { version: '2.0.0' },
    { platform: '' },
    { architecture: '' },
    { helper: undefined },
    { helper: { ...check.helper, architecture: 'x64' } },
    { platform: 'linux' },
  ]) {
    assert.equal(
      schema.safeParse({
        ...report,
        checks: [{ ...report.checks[0], ...changes }],
      }).success,
      false,
    );
  }

  for (const platform of ['linux', 'win32']) {
    const platformReport = {
      ...report,
      platform,
      checks: [
        {
          name: 'native-terminal-runtime',
          status: 'passed',
          version: check.version,
          platform,
          architecture: check.architecture,
        },
      ],
    };

    assert.deepEqual(schema.parse(platformReport), platformReport);
  }
});

test('diagnostic CLI options reject ignored or duplicate arguments', () => {
  assert.deepEqual(parseDoctorArguments([]), { json: false, browser: 'chrome' });
  assert.deepEqual(parseDoctorArguments(['--json']), { json: true, browser: 'chrome' });

  assert.deepEqual(parseDoctorArguments(['--json', '--chromium']), { json: true, browser: 'chromium' });

  for (const args of [['--json', '--json'], ['--json', '--unknown'], ['--help'], ['extra']]) {
    assert.throws(() => {
      parseDoctorArguments(args);
    }, /Usage:/);
  }
});

test('build reports reuse exact font identity instead of accepting arbitrary metadata', () => {
  const report = {
    version: '1.2.3-rc.1',
    extensionId: identity.extensionId,
    terminalFont: {
      family: 'FiraCode Nerd Font Mono',
      style: 'Regular',
      sha256: 'a'.repeat(64),
      copyright: 'Copyright fixture',
    },
    bundleModulesChecked: 3,
    pageSHA256: 'b'.repeat(64),
  };

  assert.deepEqual(buildVerificationSchema.parse(report), report);

  for (const changes of [
    { version: 'latest' },
    { bundleModulesChecked: -1 },
    { pageSHA256: 'not-a-digest' },
    { terminalFont: { ...report.terminalFont, family: 'FiraCode Nerd Font' } },
    { terminalFont: { ...report.terminalFont, style: 'Bold' } },
    { extra: true },
  ]) {
    assert.equal(buildVerificationSchema.safeParse({ ...report, ...changes }).success, false);
  }
});

test('JSON contract errors retain syntax and Zod causes without displaying serialized payloads', () => {
  const schema = z.strictObject({ name: z.string().min(1).describe('A fixture name.') });
  const message = 'Invalid fixture configuration. Check the local file.';

  assert.deepEqual(parseJsonContract(schema, '{"name":"valid"}', message), { name: 'valid' });

  for (const [serialized, causeName] of [
    ['{broken}', 'SyntaxError'],
    ['{"name":123}', 'ZodError'],
  ]) {
    assert.throws(
      () => {
        parseJsonContract(schema, serialized, message);
      },
      (error) => {
        assert.equal(error.message, message);
        assert.equal(error.cause.name, causeName);
        assert.doesNotMatch(error.message, /invalid_type|123|broken/);

        return true;
      },
    );
  }
});

test('terminal failure reports remain valid even when the built host is unavailable', () => {
  const report = {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    installation: '/fixture',
    checks: [
      {
        name: 'native-terminal-runtime',
        status: 'failed',
        error: 'Build not present.',
      },
    ],
    modifiedFiles: false,
    spawnedProcesses: false,
    guidance: 'Read-only prerequisites.',
  };

  assert.deepEqual(terminalReportSchema().parse(report), report);
  assert.equal(
    terminalReportSchema().safeParse({
      ...report,
      checks: [{ ...report.checks[0], cause: 'x'.repeat(1001) }],
    }).success,
    false,
  );
});
