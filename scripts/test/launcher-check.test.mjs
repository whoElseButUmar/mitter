import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launcherSource } from '../installation/registration.mjs';
import { registeredLauncherDetails, inspectRegisteredLauncher } from '../installation/launcher-check.mjs';

const extensionId = 'mclgchkiejnomabbnglaodgnmfhhipep';

test('launcher inspection recognizes exact generated quoting and refuses arbitrary shell changes', () => {
  const details = {
    platform: 'darwin',
    root: "/project's folder",
    dataDirectory: '/data directory',
    nodeExecutable: '/runtime/node',
    hostScript: "/project's folder/dist/apps/host/src/native.js",
    portable: true,
  };
  const source = launcherSource(details);

  assert.deepEqual(registeredLauncherDetails(source), details);
  assert.throws(() => {
    registeredLauncherDetails(source + 'touch /tmp/never-run\n');
  }, /changed|format/);
  assert.throws(() => {
    registeredLauncherDetails(source.replace('dist/apps/host/src/native.js', 'elsewhere.js'));
  }, /outside/);
});

test(
  'read-only diagnostics reject non-executable launchers and removed runtime paths',
  { skip: process.platform !== 'darwin' },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'miter-launcher-check-'));

    context.after(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const root = path.join(directory, 'source');
    const hostScript = path.join(root, 'dist/apps/host/src/native.js');
    const nodeExecutable = path.join(root, 'node');
    const file = path.join(directory, 'native/miter-host');
    const dataDirectory = path.join(directory, 'custom state');

    await mkdir(path.dirname(hostScript), { recursive: true });
    await mkdir(path.dirname(file));
    await writeFile(hostScript, 'throw new Error("diagnostic must never execute this");');
    await writeFile(nodeExecutable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    await writeFile(
      file,
      launcherSource({
        platform: 'darwin',
        root,
        dataDirectory,
        nodeExecutable,
        hostScript,
        portable: false,
      }),
      { mode: 0o700 },
    );
    const details = await inspectRegisteredLauncher(file, extensionId, 'darwin');

    assert.equal(details.dataDirectory, dataDirectory);
    await chmod(file, 0o600);
    await assert.rejects(inspectRegisteredLauncher(file, extensionId, 'darwin'), /EACCES/);
    await chmod(file, 0o700);
    await rm(nodeExecutable);
    await assert.rejects(inspectRegisteredLauncher(file, extensionId, 'darwin'), /ENOENT/);
  },
);
