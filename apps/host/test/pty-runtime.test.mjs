import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { isMachExecutable, checkDarwinHelper, terminalBindingCandidates } from '../src/core/pty-runtime.js';
import { temporaryDirectory } from './fixtures.mjs';

function executable(architecture) {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  let cpu = 0x01000007;

  if (architecture === 'arm64') {
    cpu = 0x0100000c;
  }
  bytes.writeUInt32LE(cpu, 4);
  bytes.writeUInt32LE(2, 12);

  return bytes;
}
test('Mach-O format checks reject scripts, wrong CPU and malformed fat offsets', () => {
  assert.equal(isMachExecutable(executable('arm64'), 'arm64'), true);
  assert.equal(isMachExecutable(executable('arm64'), 'x64'), false);
  assert.equal(isMachExecutable(Buffer.from('#!/bin/sh\nexit 0'), 'arm64'), false);
  const fat = Buffer.alloc(40);
  fat.writeUInt32BE(0xcafebabf, 0);
  fat.writeUInt32BE(1, 4);
  fat.writeUInt32BE(0x0100000c, 8);
  fat.writeBigUInt64BE(9007199254740993n, 16);
  fat.writeBigUInt64BE(64n, 24);
  assert.equal(isMachExecutable(fat, 'arm64'), false);
  assert.throws(() => terminalBindingCandidates('/dependency', 'unsupported', 'arm64'), /Unsupported/);
});
test(
  'helper inspection refuses runtime chmod and linked paths; repair ' + 'replaces only the local hardlink',
  async (t) => {
    const root = await temporaryDirectory(t);
    const architecture = process.arch;
    const binding = path.join(root, 'build', 'Release', 'pty.node');
    const helper = path.join(root, 'build', 'Release', 'spawn-helper');
    await fs.mkdir(path.dirname(binding), {
      recursive: true,
    });
    await fs.writeFile(binding, 'fixture binding');
    await fs.writeFile(helper, executable(architecture), {
      mode: 0o600,
    });
    const shared = path.join(root, 'shared-store-helper');
    await fs.link(helper, shared);
    await assert.rejects(
      checkDarwinHelper(root, binding, {
        arch: architecture,
      }),
      /NOT_EXECUTABLE/,
    );
    assert.equal((await fs.stat(shared)).mode & 0o100, 0);
    const repaired = await checkDarwinHelper(root, binding, {
      arch: architecture,
      repair: true,
    });
    assert.equal(repaired.repaired, true);
    assert.equal(repaired.sharedInode, true);
    assert.equal((await fs.stat(helper)).nlink, 1);
    assert.equal((await fs.stat(shared)).mode & 0o100, 0);
    assert.equal((await fs.stat(helper)).mode & 0o100, 0o100);
    await fs.unlink(helper);
    await fs.symlink(shared, helper);
    await assert.rejects(
      checkDarwinHelper(root, binding, {
        arch: architecture,
        repair: true,
      }),
      /HELPER_PATH/,
    );
  },
);
