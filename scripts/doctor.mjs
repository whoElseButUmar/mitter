/** Read-only installation diagnostics. No network, model calls or project edits. */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { installedPackageSchema, extensionIdentitySchema } from './installation/contracts.mjs';
import { doctorArgumentsSchema, installationReportSchema } from './diagnostics/contracts.mjs';
import { errorMessage, isMainModule, parseJsonContract } from './helpers/runtime.mjs';

export async function inspectInstallation(root) {
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
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    installation: root,
    dataDirectory: path.resolve(process.env.MITTER_HOME || path.join(os.homedir(), '.mitter')),
    identity,
    dependencies: [],
    assets: [],
    checks: [],
    networkRequested: false,
    projectFilesChanged: false,
  };

  for (const name of ['typescript', 'xstate', 'better-sqlite3', 'node-llama-cpp']) {
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
    'pnpm-lock.yaml',
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

  report.guidance = [
    'Disable the extension before offline restore/installation, but do not uninstall it.',
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
    const detail = check.error || check.next || '';

    console.log('\n' + check.name + ': ' + check.status + ' ' + detail);
  }

  console.log('\n' + report.guidance.join('\n'));
}

export function parseDoctorArguments(args) {
  const parsed = doctorArgumentsSchema.safeParse(args);

  if (!parsed.success) {
    throw new Error('Usage: node scripts/doctor.mjs [--json]', { cause: parsed.error });
  }

  return { json: parsed.data.includes('--json') };
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseDoctorArguments(process.argv.slice(2));
    const root = path.resolve(import.meta.dirname, '..');
    const report = await inspectInstallation(root);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }

    if (
      report.checks.some((check) => {
        return check.status === 'failed';
      })
    ) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Installation diagnostics failed:', errorMessage(error));
    process.exitCode = 1;
  }
}
