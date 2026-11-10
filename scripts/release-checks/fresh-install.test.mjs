import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  freshInstallEnvironment,
  parseFreshInstallArguments,
  snapshotSource,
  verifyFreshInstall,
} from './fresh-install.mjs';

const posix = { skip: process.platform === 'win32', timeout: 15000 };

async function fixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mitter-fresh-install-test-'));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function write(directory, filename, bytes) {
  const target = path.join(directory, filename);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

test('fresh-install CLI validates deadlines and exact worker argv without launching optional workflows', () => {
  assert.deepEqual(parseFreshInstallArguments([]), { mode: 'verify', timeoutMs: 480000 });
  assert.deepEqual(parseFreshInstallArguments(['--timeout-ms=1000']), { mode: 'verify', timeoutMs: 1000 });
  assert.deepEqual(parseFreshInstallArguments(['--timeout-ms=900000']), {
    mode: 'verify',
    timeoutMs: 900000,
  });
  const source = path.resolve('/source');
  const directory = path.resolve('/owned/tmp');
  assert.deepEqual(parseFreshInstallArguments(['--install-worker', source, directory]), {
    mode: 'worker',
    source,
    directory,
  });

  for (const args of [
    ['--timeout-ms=999'],
    ['--timeout-ms=900001'],
    ['--timeout-ms=-1'],
    ['--timeout-ms=1e3'],
    ['--timeout-ms=' + '9'.repeat(400)],
    ['--timeout-ms=1000', '--timeout-ms=2000'],
    ['--help'],
    ['--install-worker', source],
    ['--install-worker', source, directory, 'extra'],
    ['--install-worker', 'relative-source', directory],
    ['--install-worker', source, directory + '\0'],
  ]) {
    assert.throws(
      () => {
        parseFreshInstallArguments(args);
      },
      (error) => {
        assert.match(error.message, /Usage:/);
        assert.equal(error.cause.name, 'ZodError');

        return true;
      },
    );
  }
});

test(
  'fresh-install refuses an existing work tree before launch or cleanup can replace it',
  posix,
  async (context) => {
    const directory = await fixture(context);
    const source = path.join(directory, 'source');
    const run = path.join(directory, 'run');
    await write(source, 'canary', 'source bytes');
    await write(run, 'work/canary', 'previous caller-owned bytes');

    await assert.rejects(
      verifyFreshInstall({ source, directory: run, timeoutMs: 1000 }),
      /work directory already exists/,
    );
    assert.equal(await readFile(path.join(run, 'work/canary'), 'utf8'), 'previous caller-owned bytes');
    await assert.rejects(access(path.join(run, 'build.log')), { code: 'ENOENT' });
  },
);

test(
  'fresh-install rejects overlapping source/work trees and directories outside the temporary root',
  posix,
  async (context) => {
    const directory = await fixture(context);
    await write(directory, 'canary', 'caller-owned bytes');

    for (const source of [directory, path.join(directory, 'work/source')]) {
      await assert.rejects(
        verifyFreshInstall({ source, directory, timeoutMs: 1000 }),
        /source and work trees must not overlap/,
      );
    }
    await assert.rejects(
      verifyFreshInstall({ source: directory, directory: path.parse(directory).root, timeoutMs: 1000 }),
      /strictly inside the system temporary directory/,
    );
    assert.equal(await readFile(path.join(directory, 'canary'), 'utf8'), 'caller-owned bytes');
    await assert.rejects(access(path.join(directory, 'work')), { code: 'ENOENT' });
  },
);

test('snapshot copies dirty and untracked bytes, not generated files, caches or user state', async (context) => {
  const directory = await fixture(context);
  const source = path.join(directory, 'source');
  const checkout = path.join(directory, 'checkout');
  const files = new Map([
    ['scripts/setup.mjs', Buffer.from('dirty working-tree source\r\n')],
    ['packages/new/untracked.mjs', Buffer.from([0, 10, 128, 255])],
    ['.hidden-source', Buffer.from('untracked hidden source')],
    ['pnpm-workspace.yaml', Buffer.from('allowBuilds:\n  node-pty: true\nminimumReleaseAge: 1440\n')],
  ]);
  for (const [filename, bytes] of files) {
    await write(source, filename, bytes);
  }
  const generated = [
    '.git/config',
    '.cache/input',
    '.pnpm-store/input',
    '.npm/input',
    'node_modules/dependency/index.js',
    'dist/host.js',
    'apps/extension/.output/chrome-mv3/manifest.json',
    'apps/extension/.output/chrome-mv3/fonts/FiraCodeNerdFontMono-Regular.ttf',
    'apps/extension/.output/chrome-mv3/fonts/OFL.txt',
    'apps/extension/.wxt/types.d.ts',
    'pnpm-lock.yaml',
    'apps/extension/public/mitter-page.js',
    'apps/extension/public/preview-sandbox.js',
    'packages/new/tsconfig.tsbuildinfo',
    'coverage/result.json',
    '.mitter/config.json',
    'state.sqlite-wal',
    'model.gguf',
  ];
  for (const filename of generated) {
    await write(source, filename, 'leave real state alone');
  }
  await snapshotSource(source, checkout);
  for (const [filename, bytes] of files) {
    assert.deepEqual(await readFile(path.join(checkout, filename)), bytes);
    assert.deepEqual(await readFile(path.join(source, filename)), bytes);
  }
  for (const filename of generated) {
    await assert.rejects(access(path.join(checkout, filename)), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(source, filename), 'utf8'), 'leave real state alone');
  }
});

test('snapshot rejects source symlinks instead of retaining access to real files', async (context) => {
  const directory = await fixture(context);
  const source = path.join(directory, 'source');
  await write(directory, 'real.mjs', 'user source');
  await mkdir(source);
  await symlink(path.join(directory, 'real.mjs'), path.join(source, 'escape.mjs'));
  await assert.rejects(
    snapshotSource(source, path.join(directory, 'checkout')),
    /Source symlink could escape/,
  );
  assert.equal(await readFile(path.join(directory, 'real.mjs'), 'utf8'), 'user source');
});

test('fresh environment only inherits executable discovery, locale and proxy/trust settings', () => {
  const work = path.join(os.tmpdir(), 'isolated-work');
  const allowed = {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    HTTPS_PROXY: 'http://proxy.invalid',
    no_proxy: 'localhost',
    NODE_EXTRA_CA_CERTS: '/system/ca.pem',
  };
  const unsafe = {
    HOME: '/real/home',
    XDG_RUNTIME_DIR: '/real/runtime',
    TMPDIR: '/real/tmp',
    npm_config_registry: 'http://registry.invalid',
    NPM_CONFIG_PREFIX: '/real/prefix',
    npm_execpath: '/real/pnpm',
    npm_lifecycle_script: 'injected',
    npm_package_config_key: 'injected',
    PNPM_HOME: '/real/pnpm',
    COREPACK_HOME: '/real/corepack',
    INIT_CWD: '/real/checkout',
    NODE_OPTIONS: '--require=/real/preload.cjs',
    node_path: '/real/modules',
    LD_PRELOAD: '/real/preload.so',
    DYLD_INSERT_LIBRARIES: '/real/preload.dylib',
    BASH_ENV: '/real/shell',
    PYTHONPATH: '/real/python',
    CCACHE_DIR: '/real/cache',
    MITER_FONT_FILE: '/real/font',
    MITER_FONT_SHA256: 'inherited digest',
    MITTER_HOME: '/real/state',
    CI: 'false',
    UNRELATED_SECRET: 'must not reach the build',
  };
  const inherited = { ...allowed, ...unsafe };
  const env = freshInstallEnvironment(work, inherited);
  assert.deepEqual(inherited, { ...allowed, ...unsafe });
  for (const [key, value] of Object.entries(allowed)) {
    assert.equal(env[key], value);
  }
  for (const key of Object.keys(unsafe)) {
    assert.notEqual(env[key], unsafe[key], key);
  }
  assert.equal(env.CI, 'true');
  for (const [key, value] of Object.entries(env)) {
    if (!(key in allowed) && key !== 'CI') {
      assert.ok(value.startsWith(work + path.sep), key + ' belongs to the isolated work tree');
    }
  }
});

async function sourceFixture(context) {
  const directory = await fixture(context);
  const source = path.join(directory, 'source');
  const run = path.join(directory, 'run');
  await mkdir(run);
  await write(source, 'pnpm-workspace.yaml', 'allowBuilds:\n  node-pty: true\n');
  await write(
    source,
    'scripts/setup.mjs',
    `
    import assert from 'node:assert/strict';
    import { existsSync, readFileSync } from 'node:fs';
    assert.equal(readFileSync(process.env.MITER_FONT_FILE, 'utf8'), 'fixture font bytes');
    assert.equal(readFileSync(process.env.MITER_FONT_LICENSE, 'utf8'), 'fixture license bytes');
    assert.equal(existsSync('apps/extension/.output'), false);
    console.log('fixture setup', process.argv[2]);
  `,
  );
  await write(source, 'scripts/verify-build.mjs', 'console.log("fixture verification");');
  await write(
    source,
    'apps/extension/.output/chrome-mv3/fonts/FiraCodeNerdFontMono-Regular.ttf',
    'fixture font bytes',
  );
  await write(source, 'apps/extension/.output/chrome-mv3/fonts/OFL.txt', 'fixture license bytes');
  return { directory, source, run, log: path.join(run, 'build.log') };
}

async function waitForSnapshot(log) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      if (/Snapshotting source/.test(await readFile(log, 'utf8'))) {
        await access(path.join(path.dirname(log), 'work', 'checkout'));
        return;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    await delay(10);
  }
  throw new Error('Snapshot worker did not start before the test deadline.');
}

test(
  'fixture-only workflow copies fonts, runs build-only/verification and removes work, not source',
  posix,
  async (context) => {
    const { source, run, log } = await sourceFixture(context);
    await verifyFreshInstall({ source, directory: run, timeoutMs: 5000 });
    const output = await readFile(log, 'utf8');
    const fontDigest = createHash('sha256').update('fixture font bytes').digest('hex');
    assert.ok(output.includes('Font SHA256: ' + fontDigest));
    assert.match(output, /fixture setup --build-only/);
    assert.match(output, /fixture verification/);
    await assert.rejects(access(path.join(run, 'work')), { code: 'ENOENT' });
    assert.equal(
      await readFile(path.join(source, 'apps/extension/.output/chrome-mv3/fonts/OFL.txt'), 'utf8'),
      'fixture license bytes',
    );
  },
);

for (const filename of ['FiraCodeNerdFontMono-Regular.ttf', 'OFL.txt']) {
  test(
    'missing packaged ' + filename + ' requires a build, never a cache fallback',
    posix,
    async (context) => {
      const { source, run, log } = await sourceFixture(context);
      const input = path.join(source, 'apps/extension/.output/chrome-mv3/fonts', filename);
      await rm(input);
      await write(source, '.cache/build-font/' + filename, 'must not reuse private cache');
      await assert.rejects(verifyFreshInstall({ source, directory: run, timeoutMs: 5000 }), /exited 1/);
      const output = await readFile(log, 'utf8');
      assert.ok(output.includes('Missing packaged build font input: ' + input));
      assert.ok(output.includes('Run pnpm build in ' + source + ' before fresh-install verification.'));
      assert.match(output, /ENOENT.*copyfile/);
      assert.match(output, /FAIL:/);
      assert.doesNotMatch(output, /Command: node scripts\/setup/);
      await assert.rejects(access(path.join(run, 'work')), { code: 'ENOENT' });
    },
  );
}

test('deadline kills blocked font-copy preparation before removing work', posix, async (context) => {
  const { source, run, log } = await sourceFixture(context);
  const font = path.join(source, 'apps/extension/.output/chrome-mv3/fonts/FiraCodeNerdFontMono-Regular.ttf');
  await rm(font);
  execFileSync('mkfifo', [font], { timeout: 1000 });
  // Unblock a broken runner after two seconds; the writer also has its own finite lifetime.
  const writer = spawn(
    process.execPath,
    [
      '-e',
      'setTimeout(() => require("node:fs").writeFile(' +
        JSON.stringify(font) +
        ', "fixture font", () => {}), 2000);' +
        'setTimeout(() => process.exit(0), 3500);',
    ],
    { stdio: 'ignore', env: { PATH: process.env.PATH } },
  );
  const closed = new Promise((resolve, reject) => {
    writer.once('error', reject);
    writer.once('close', resolve);
  });
  try {
    await assert.rejects(verifyFreshInstall({ source, directory: run, timeoutMs: 1000 }), /Timed out/);
    const output = await readFile(log, 'utf8');
    assert.match(output, /Copying packaged build font inputs/);
    assert.doesNotMatch(output, /Command: node scripts\/setup/);
    await assert.rejects(access(path.join(run, 'work')), { code: 'ENOENT' });
    await delay(100);
    await assert.rejects(access(path.join(run, 'work')), { code: 'ENOENT' });
  } finally {
    writer.kill('SIGKILL');
    await closed;
  }
});

test(
  'abort during snapshot stops filesystem work before cleanup; no late copy recreates work',
  posix,
  async (context) => {
    const { source, run, log } = await sourceFixture(context);
    for (let index = 0; index < 1000; index++) {
      await write(source, 'files/' + index + '.mjs', 'untracked source bytes');
    }
    const controller = new AbortController();
    const reason = new Error('abort snapshot');
    const running = verifyFreshInstall({
      source,
      directory: run,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    const rejected = assert.rejects(running, (error) => error === reason);
    try {
      await waitForSnapshot(log);
      await access(path.join(run, 'work'));
      controller.abort(reason);
      await rejected;
      assert.doesNotMatch(await readFile(log, 'utf8'), /Command: node scripts\/setup/);
      await assert.rejects(access(path.join(run, 'work')), { code: 'ENOENT' });
      await delay(200);
      await assert.rejects(access(path.join(run, 'work')), { code: 'ENOENT' });
      assert.equal(await readFile(path.join(source, 'files/999.mjs'), 'utf8'), 'untracked source bytes');
    } finally {
      controller.abort(reason);
      await rejected;
    }
  },
);

test(
  'one deadline covers preparation and a real build descendant; timeout keeps logs and cleans work',
  posix,
  async (context) => {
    const { directory, source, run, log } = await sourceFixture(context);
    const marker = path.join(directory, 'escaped-build');
    const descendant =
      'setTimeout(() => require("node:fs").writeFileSync(' +
      JSON.stringify(marker) +
      ', "bad"), 1800);' +
      'setTimeout(() => process.exit(0), 3000);';
    await write(
      source,
      'scripts/setup.mjs',
      'import { spawn } from "node:child_process";' +
        'spawn(process.execPath, ["-e", ' +
        JSON.stringify(descendant) +
        '], { stdio: "ignore" });' +
        'console.log("fixture build descendant started"); setTimeout(() => process.exit(0), 4000);',
    );
    await assert.rejects(verifyFreshInstall({ source, directory: run, timeoutMs: 1000 }), /Timed out/);
    assert.match(await readFile(log, 'utf8'), /fixture build descendant started/);
    await assert.rejects(access(path.join(run, 'work')), { code: 'ENOENT' });
    await delay(1900);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    await assert.rejects(access(path.join(run, 'work')), { code: 'ENOENT' });
  },
);
