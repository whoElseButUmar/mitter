/** Read-only installation diagnostics. No network, model calls or project edits. */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {
  installedPackageSchema,
  extensionIdentitySchema,
  nativeManifestSchema,
} from './installation/contracts.mjs';
import { doctorArgumentsSchema, installationReportSchema } from './diagnostics/contracts.mjs';
import { inspectRegisteredLauncher } from './installation/launcher-check.mjs';
import { supportsSetupNode } from './installation/bootstrap.mjs';
import { registrationPaths } from './installation/registration.mjs';
import { errorMessage, isMainModule, parseJsonContract } from './helpers/runtime.mjs';

export async function inspectInstallation(
  root,
  {
    home = os.homedir(),
    nodeVersion = process.versions.node,
    platform = process.platform,
    browser = 'chrome',
  } = {},
) {
  const require = createRequire(path.join(root, 'package.json'));
  const serializedPackage = readFileSync(path.join(root, 'package.json'), 'utf8');
  const project = parseJsonContract(
    installedPackageSchema,
    serializedPackage,
    'Invalid installation metadata in package.json. Check the version and pinned runtime settings.',
  );
  const serializedIdentity = readFileSync(path.join(root, 'brand/extension-identity.json'), 'utf8');
  const identity = parseJsonContract(
    extensionIdentitySchema,
    serializedIdentity,
    'Invalid extensionId or key in brand/extension-identity.json. Restore the stable extension identity.',
  );
  const report = {
    product: 'Miter',
    version: project.version,
    node: 'v' + nodeVersion,
    platform,
    architecture: process.arch,
    installation: root,
    dataDirectory: path.resolve(process.env.MITTER_HOME || path.join(home, '.mitter')),
    identity,
    dependencies: [],
    assets: [],
    checks: [],
    networkRequested: false,
    projectFilesChanged: false,
  };

  for (const name of ['zod', 'xstate', 'better-sqlite3', 'node-pty', 'rolldown', 'node-llama-cpp']) {
    try {
      report.dependencies.push({
        name,
        status: 'found',
        path: require.resolve(name),
      });
    } catch {
      report.dependencies.push({
        name,
        status: 'not-installed',
        optional: name === 'node-llama-cpp',
      });
    }
  }

  const assets = [
    'dist/apps/host/src/native.js',
    'apps/extension/.output/chrome-mv3/manifest.json',
    'apps/extension/.output/chrome-mv3/mitter-page.js',
  ];

  for (const file of assets) {
    let status = 'missing';

    if (existsSync(path.join(root, file))) {
      status = 'found';
    }

    report.assets.push({ file, status });
  }

  if (existsSync(path.join(root, 'apps/extension/.output/chrome-mv3/manifest.json'))) {
    try {
      const { verifyBuild } = await import('./verify-build.mjs');
      const detail = await verifyBuild(root);

      report.checks.push({
        name: 'production-assets',
        status: 'passed',
        detail,
      });
    } catch (error) {
      report.checks.push({
        name: 'production-assets',
        status: 'failed',
        error: errorMessage(error),
      });
    }
  } else {
    report.checks.push({
      name: 'production-assets',
      status: 'not-built',
      next: 'Run node scripts/setup.mjs. A source-only folder cannot be loaded as an unpacked extension.',
    });
  }

  let runtimeStatus = 'failed';
  let runtimeDetail = 'Install Node.js 26 or newer, then rerun node scripts/setup.mjs.';

  if (supportsSetupNode(nodeVersion)) {
    runtimeStatus = 'passed';
    runtimeDetail = 'Node.js ' + nodeVersion + ' meets the minimum version.';
  }

  report.checks.push({ name: 'node-runtime', status: runtimeStatus, detail: runtimeDetail });
  let isolationStatus = 'failed';
  let isolationDetail = 'Automatic app tests currently require macOS and Node.js 26 or newer.';

  if (platform === 'darwin' && runtimeStatus === 'passed' && existsSync('/usr/bin/sandbox-exec')) {
    isolationStatus = 'passed';
    isolationDetail =
      'Required macOS sandbox executable and Node version are present. The managed installer performs an execution check; this read-only diagnostic does not.';
  }

  report.checks.push({ name: 'automatic-app-checks', status: isolationStatus, detail: isolationDetail });
  const paths = registrationPaths({
    platform,
    home,
    root,
    browser,
    nativeHost: identity.nativeHost,
  });

  try {
    const manifest = nativeManifestSchema.parse(JSON.parse(readFileSync(paths.manifestPath, 'utf8')));

    if (
      manifest.name !== identity.nativeHost ||
      manifest.allowed_origins[0] !== `chrome-extension://${identity.extensionId}/`
    ) {
      throw new Error('The registration identity or launcher is missing.');
    }

    const launcher = await inspectRegisteredLauncher(manifest.path, identity.extensionId, platform);

    if (launcher) {
      report.dataDirectory = launcher.dataDirectory;
    }

    report.checks.push({
      name: 'native-registration',
      status: 'passed',
      detail:
        'Registered ' +
        browser +
        ' launcher and runtime files verified: ' +
        manifest.path +
        '. Confirm the live connection inside Miter.',
    });
  } catch (error) {
    report.checks.push({
      name: 'native-registration',
      status: 'failed',
      detail:
        browser +
        ' registration is missing or invalid. Run node scripts/setup.mjs, or rerun Install Miter.command. ' +
        errorMessage(error),
    });
  }

  report.guidance = [
    'After an update, reload Miter on chrome://extensions, then close and reopen the workspace. Disable the extension before an offline state restore.',
    'State backups include journaled source, not project files, external worktrees ' +
      'or Chrome storage preferences.',
    'Use Connection & health in Miter for a live database check. ' +
      'This command does not open or mutate its database.',
    'Logs can include private paths. Review this report before sharing.',
  ];

  return installationReportSchema.parse(report);
}

function printReport(report) {
  console.log(
    `Miter ${report.version}\n${report.node} · ${report.platform}/${report.architecture}\n` +
      `Installation: ${report.installation}\nState: ${report.dataDirectory}\n`,
  );

  for (const dependency of report.dependencies) {
    let optionalLabel = '';

    if (dependency.optional) {
      optionalLabel = ' (optional)';
    }

    console.log(dependency.name + ': ' + dependency.status + optionalLabel);
  }

  for (const asset of report.assets) {
    console.log(asset.file + ': ' + asset.status);
  }

  for (const check of report.checks) {
    let detail = check.error || check.next || '';

    if (typeof check.detail === 'string') {
      detail = check.detail;
    }

    console.log('\n' + check.name + ': ' + check.status + ' ' + detail);
  }

  console.log('\n' + report.guidance.join('\n'));
}

export function installationReady(report) {
  return (
    report.checks.every((check) => {
      return check.status === 'passed';
    }) &&
    report.dependencies.every((dependency) => {
      return dependency.status === 'found' || dependency.optional;
    }) &&
    report.assets.every((asset) => {
      return asset.status === 'found';
    })
  );
}

export function parseDoctorArguments(args) {
  const parsed = doctorArgumentsSchema.safeParse(args);

  if (!parsed.success) {
    throw new Error('Usage: node scripts/doctor.mjs [--json] [--chromium]', { cause: parsed.error });
  }

  let browser = 'chrome';

  if (parsed.data.includes('--chromium')) {
    browser = 'chromium';
  }

  return { json: parsed.data.includes('--json'), browser };
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseDoctorArguments(process.argv.slice(2));
    const root = path.resolve(import.meta.dirname, '..');
    const report = await inspectInstallation(root, { browser: options.browser });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }

    if (!installationReady(report)) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Installation diagnostics failed:', errorMessage(error));
    process.exitCode = 1;
  }
}
