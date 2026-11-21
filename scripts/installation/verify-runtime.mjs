import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import pty from 'node-pty';
import { runQualityTests } from '../../dist/apps/host/src/core/quality/runner.js';
import { managedPnpmExecutable } from '../../dist/apps/host/src/core/managed-pnpm.js';
import { installedPackageSchema } from './contracts.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'miter-install-check-'));

try {
  const metadata = installedPackageSchema.parse(
    JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')),
  );
  const pnpmVersion = execFileSync(managedPnpmExecutable(), ['--version'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10000,
  }).trim();
  if ('pnpm@' + pnpmVersion !== metadata.packageManager) {
    throw new Error('The bundled pnpm executable does not match the project package manager.');
  }
  const database = new Database(':memory:');

  try {
    if (database.prepare('SELECT 1 AS ready').get().ready !== 1) {
      throw new Error('The bundled SQLite runtime did not pass its read/write smoke check.');
    }
  } finally {
    database.close();
  }

  await new Promise((resolve, reject) => {
    let output = '';
    const terminal = pty.spawn('/bin/sh', ['-c', 'printf miter-terminal-ready'], {
      cwd: directory,
      env: { HOME: directory, TMPDIR: directory, PATH: '/usr/bin:/bin' },
    });
    const timer = setTimeout(() => {
      terminal.kill();
      reject(new Error('The bundled terminal did not exit within five seconds.'));
    }, 5000);

    terminal.onData((chunk) => {
      output += chunk;
    });
    terminal.onExit((event) => {
      clearTimeout(timer);

      if (event.exitCode === 0 && output.includes('miter-terminal-ready')) {
        resolve();
      } else {
        reject(new Error('The bundled terminal smoke check failed.'));
      }
    });
  });
  const dataDir = path.join(directory, 'checks');

  await mkdir(dataDir);
  const result = await runQualityTests({
    files: [
      {
        path: 'install.test.mjs',
        content:
          "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('runtime works', () => { assert.equal(2 + 2, 4); });",
      },
    ],
    tests: ['install.test.mjs'],
    dataDir,
    signal: AbortSignal.timeout(20000),
  });

  if (!result.ok || result.testCount < 1) {
    throw new Error('Automatic app checks are unavailable: ' + result.detail);
  }

  console.log('Bundled runtime verified: pnpm, SQLite, terminal and isolated app tests.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
