/** Read-only diagnostic: loads the native binding and inspects its selected helper,
 * shell and temp directory. Never starts a shell, chmods or clears xattrs.
 * Paths may be private; review output before sharing.
 */
import path from 'node:path';
import os from 'node:os';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import { requireNativeTerminalSchema, terminalReportSchema } from './diagnostics/contracts.mjs';
import { errorMessage, isMainModule, parseContract } from './helpers/runtime.mjs';

export async function inspectTerminal(root) {
  const report = {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    installation: root,
    checks: [],
    modifiedFiles: false,
    spawnedProcesses: false,
  };
  let shellPath = '/bin/sh';

  if (process.platform === 'win32') {
    shellPath = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
  }

  const prerequisites = [
    ['temporary-directory', os.tmpdir(), constants.R_OK | constants.W_OK | constants.X_OK],
    ['shell', shellPath, constants.X_OK],
  ];

  for (const [name, file, mode] of prerequisites) {
    try {
      await access(file, mode);
      const canonicalPath = await realpath(file);

      report.checks.push({ name, status: 'passed', path: canonicalPath });
    } catch (error) {
      report.checks.push({
        name,
        status: 'failed',
        error: errorMessage(error),
      });
    }
  }

  let nativeCheckSchema;

  try {
    const runtime = await import('../dist/apps/host/src/core/pty-runtime.js');
    nativeCheckSchema = requireNativeTerminalSchema(runtime);
    const result = await runtime.prepareNativeTerminal({ root });
    const check = parseContract(
      nativeCheckSchema,
      result.check,
      'Invalid native terminal preflight result. Run pnpm build:host before retrying.',
    );

    report.checks.push({
      name: 'native-terminal-runtime',
      status: 'passed',
      ...check,
    });
  } catch (error) {
    let cause;

    if (error instanceof Error && error.cause instanceof Error && !(error.cause instanceof z.ZodError)) {
      cause = error.cause.message.slice(0, 1000);
    }

    report.checks.push({
      name: 'native-terminal-runtime',
      status: 'failed',
      error: errorMessage(error),
      cause,
    });
  }

  report.guidance =
    'These are prerequisites, not proof of an OS launch. ' +
    'No permissions, quarantine flags or other macOS security settings were changed.';

  return terminalReportSchema(nativeCheckSchema).parse(report);
}

if (isMainModule(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('Usage: node scripts/terminal-doctor.mjs');
    process.exitCode = 1;
  } else {
    const root = path.resolve(import.meta.dirname, '..');
    const report = await inspectTerminal(root);

    console.log(JSON.stringify(report, null, 2));

    if (
      report.checks.some((check) => {
        return check.status === 'failed';
      })
    ) {
      process.exitCode = 1;
    }
  }
}
