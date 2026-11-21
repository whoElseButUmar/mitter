import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import {
  parseSetupArguments,
  readModelRuntimePackages,
  readPackageManager,
  supportsSetupNode,
} from '../installation/bootstrap.mjs';
import { parsePreparationArguments } from '../prepare-terminal.mjs';
import { quotePosix } from '../installation/registration.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const commandRecordSchema = z
  .array(z.string().describe('One exact recorded package manager or terminal argument.'))
  .describe('The command argv recorded by the dependency-free setup fixture.');

async function bootstrapFixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mitter-bootstrap-'));

  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, 'scripts/installation'), {
    recursive: true,
  });
  await mkdir(path.join(directory, 'scripts/helpers'), { recursive: true });

  const scripts = ['setup.mjs', 'install-models.mjs', 'installation/bootstrap.mjs', 'helpers/runtime.mjs'];

  for (const file of scripts) {
    await copyFile(path.join(root, 'scripts', file), path.join(directory, 'scripts', file));
  }

  return directory;
}

function runNode(directory, args, environment = process.env) {
  return spawnSync(process.execPath, args, {
    cwd: directory,
    env: environment,
    encoding: 'utf8',
    shell: false,
    timeout: 10000,
  });
}

async function recordedSetupFixture(context) {
  const directory = await bootstrapFixture(context);
  const bin = path.join(directory, 'bin');
  const recorder = path.join(bin, 'record-command.mjs');
  const manager = 'pnpm@12.10.1';

  await mkdir(bin);
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ packageManager: manager }));
  await writeFile(
    recorder,
    'import { appendFileSync } from "node:fs";\n' +
      'appendFileSync("commands.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");\n' +
      'appendFileSync("build-consent.txt", String(process.env.PNPM_CONFIG_STRICT_DEP_BUILDS) + "\\n");\n' +
      'if (process.env.MITTER_FIXTURE_NETWORK_BLOCKED === "1") {\n' +
      '  console.error("fixture network disabled"); process.exitCode = 1;\n' +
      '}\n',
  );

  if (process.platform === 'win32') {
    await writeFile(
      path.join(bin, 'npx.cmd'),
      '@echo off\r\n"' + process.execPath + '" "' + recorder + '" %*\r\n',
    );
  } else {
    await writeFile(
      path.join(bin, 'npx'),
      '#!/bin/sh\nexec ' + quotePosix(process.execPath) + ' ' + quotePosix(recorder) + ' "$@"\n',
      { mode: 0o700 },
    );
  }

  await writeFile(
    path.join(directory, 'scripts/prepare-terminal.mjs'),
    'import { appendFileSync } from "node:fs";\n' +
      'appendFileSync("commands.jsonl", JSON.stringify(["terminal", ...process.argv.slice(2)]) + "\\n");\n',
  );
  const environment = {
    ...process.env,
    PATH: bin + path.delimiter + (process.env.PATH ?? ''),
    CI: 'true',
    MITTER_FIXTURE_NETWORK_BLOCKED: '',
    PNPM_CONFIG_STRICT_DEP_BUILDS: 'false',
  };

  return { directory, environment, manager };
}

test('bootstrap package manager guard accepts only exact pnpm specifiers', () => {
  assert.equal(readPackageManager({ packageManager: 'pnpm@12.10.1' }), 'pnpm@12.10.1');

  for (const project of [
    null,
    [],
    {},
    { packageManager: 12 },
    { packageManager: 'pnpm@latest' },
    { packageManager: 'npm@12.10.1' },
    { packageManager: 'pnpm@12.10.1; echo unsafe' },
  ]) {
    assert.throws(() => {
      readPackageManager(project);
    }, /pin packageManager/);
  }
});

test('bootstrap model runtime guards validate records, names and exact version pins', () => {
  assert.deepEqual(
    readModelRuntimePackages({
      mitter: {
        modelRuntimes: {
          'node-llama-cpp': '3.22.1',
          '@example/runtime': '1.2.3-rc.1',
        },
      },
    }),
    ['node-llama-cpp@3.22.1', '@example/runtime@1.2.3-rc.1'],
  );

  for (const project of [null, [], {}, { mitter: [] }, { mitter: { modelRuntimes: [] } }]) {
    assert.throws(() => {
      readModelRuntimePackages(project);
    }, /modelRuntimes object/);
  }

  for (const packages of [
    {},
    { runtime: 3 },
    { runtime: '^3.22.1' },
    { runtime: 'latest' },
    { '--registry=unsafe': '1.0.0' },
    { '../runtime': '1.0.0' },
    { runtime: '1.0.0 & echo unsafe' },
  ]) {
    assert.throws(() => {
      readModelRuntimePackages({ mitter: { modelRuntimes: packages } });
    }, /pin at least one|exact VERSION/);
  }
});

test('setup flags require Node 26 and keep build-only installation separate', () => {
  assert.deepEqual(parseSetupArguments([]), {
    buildOnly: false,
    chromium: false,
    help: false,
    destination: undefined,
  });
  assert.deepEqual(parseSetupArguments(['--build-only', '--chromium', '--help']), {
    buildOnly: true,
    chromium: true,
    help: true,
    destination: undefined,
  });

  for (const args of [['--help', '--unknown'], ['--chromium', '--chromium'], ['--portable']]) {
    assert.throws(() => {
      parseSetupArguments(args);
    }, /Usage:/);
  }

  assert.equal(supportsSetupNode('22.15.0'), false);
  assert.equal(supportsSetupNode('22.16.0'), false);
  assert.equal(supportsSetupNode('26.0.0'), true);
  assert.equal(supportsSetupNode('21.99.0'), false);
  assert.equal(supportsSetupNode('invalid'), false);
});

test('terminal preparation defaults to inspection and requires one explicit repair flag', () => {
  assert.deepEqual(parsePreparationArguments([]), { repair: false });
  assert.deepEqual(parsePreparationArguments(['--check']), { repair: false });
  assert.deepEqual(parsePreparationArguments(['--repair']), { repair: true });

  for (const args of [['--repair', '--check'], ['--repair', '--repair'], ['--unknown']]) {
    assert.throws(() => {
      parsePreparationArguments(args);
    }, /Usage:/);
  }
});

test('bootstrap help and metadata reads work without node_modules', async (context) => {
  const directory = await bootstrapFixture(context);
  const project = {
    packageManager: 'pnpm@12.10.1',
    mitter: { modelRuntimes: { 'node-llama-cpp': '3.22.1' } },
  };

  await writeFile(path.join(directory, 'package.json'), JSON.stringify(project));

  for (const script of ['setup.mjs', 'install-models.mjs']) {
    const result = runNode(directory, ['scripts/' + script, '--help']);

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Install/);
  }

  const source = [
    'import { readBootstrapProject, readPackageManager, readModelRuntimePackages }',
    "  from './scripts/installation/bootstrap.mjs';",
    'const project = readBootstrapProject(process.cwd());',
    'console.log(readPackageManager(project));',
    "console.log(readModelRuntimePackages(project).join(','));",
  ].join('\n');
  const result = runNode(directory, ['--input-type=module', '-e', source]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'pnpm@12.10.1\nnode-llama-cpp@3.22.1\n');
});

test('model installation rejects unknown flags before any dependency or manifest change', async (context) => {
  const directory = await bootstrapFixture(context);
  const manifest = JSON.stringify({
    packageManager: 'pnpm@12.10.1',
    mitter: { modelRuntimes: [] },
  });

  await writeFile(path.join(directory, 'package.json'), manifest);

  for (const args of [['--dry-run'], ['--help', '--unknown'], ['--help', '--help']]) {
    const result = runNode(directory, ['scripts/install-models.mjs', ...args]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, '');
  }
});

test('fresh setup does not require a committed lockfile and skips registration in build-only mode', async (context) => {
  const fixture = await recordedSetupFixture(context);
  const manifestFile = path.join(fixture.directory, 'package.json');
  const originalManifest = await readFile(manifestFile);

  await assert.rejects(access(path.join(fixture.directory, 'pnpm-lock.yaml')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(fixture.directory, 'node_modules')), { code: 'ENOENT' });
  const result = runNode(fixture.directory, ['scripts/setup.mjs', '--build-only'], fixture.environment);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const commands = (await readFile(path.join(fixture.directory, 'commands.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => {
      return commandRecordSchema.parse(JSON.parse(line));
    });

  assert.deepEqual(commands, [
    ['--yes', fixture.manager, 'install', '--no-frozen-lockfile'],
    ['--yes', fixture.manager, 'build'],
    ['terminal', '--repair'],
  ]);
  assert.deepEqual(await readFile(manifestFile), originalManifest);
  assert.equal(await readFile(path.join(fixture.directory, 'build-consent.txt'), 'utf8'), 'true\ntrue\n');
});

test('disabled setup network stops before build, repair or registration', async (context) => {
  const fixture = await recordedSetupFixture(context);
  const result = runNode(fixture.directory, ['scripts/setup.mjs', '--build-only'], {
    ...fixture.environment,
    MITTER_FIXTURE_NETWORK_BLOCKED: '1',
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fixture network disabled/);
  assert.match(result.stderr, /Setup stopped:/);
  const commands = (await readFile(path.join(fixture.directory, 'commands.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => {
      return commandRecordSchema.parse(JSON.parse(line));
    });

  assert.deepEqual(commands, [['--yes', fixture.manager, 'install', '--no-frozen-lockfile']]);
  await assert.rejects(access(path.join(fixture.directory, 'node_modules')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(fixture.directory, 'pnpm-lock.yaml')), { code: 'ENOENT' });
});

test('invalid bootstrap metadata stops before any package manager can run', async (context) => {
  const directory = await bootstrapFixture(context);

  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ packageManager: 'invalid' }));
  const setup = runNode(directory, ['scripts/setup.mjs', '--build-only']);

  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /Setup stopped:.*pin packageManager/);
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({
      packageManager: 'pnpm@12.10.1',
      mitter: { modelRuntimes: [] },
    }),
  );
  const models = runNode(directory, ['scripts/install-models.mjs']);

  assert.equal(models.status, 1);
  assert.match(models.stderr, /modelRuntimes object/);
  assert.equal(models.stdout, '');
});
