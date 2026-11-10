import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBounded } from './bounded-process.mjs';
import { freshInstallArgumentsSchema } from './fresh-install-schemas.mjs';
import { ownedTemporaryDirectory } from './chrome-native.mjs';
import { errorMessage, hasErrorCode, isMainModule } from '../helpers/runtime.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const generatedScripts = new Set([
  path.join('apps', 'extension', 'public', 'mitter-page.js'),
  path.join('apps', 'extension', 'public', 'preview-sandbox.js'),
]);
const excluded = new Set([
  '.git',
  '.cache',
  '.pnpm-store',
  '.npm',
  '.yarn',
  '.turbo',
  '.vite',
  '.mitter',
  'node_modules',
  'dist',
  '.output',
  '.wxt',
  'coverage',
  'pnpm-lock.yaml',
  '.DS_Store',
]);

export async function snapshotSource(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: async (filename) => {
      const relative = path.relative(source, filename);
      if (
        relative.split(path.sep).some((part) => excluded.has(part)) ||
        /\.(?:tsbuildinfo|gguf|sqlite[^/]*)$/.test(relative) ||
        generatedScripts.has(relative)
      ) {
        return false;
      }
      if ((await lstat(filename)).isSymbolicLink()) {
        throw new Error('Source symlink could escape the isolated checkout: ' + relative);
      }
      return true;
    },
  });
}

export function freshInstallEnvironment(work, inherited = process.env) {
  const home = path.join(work, 'home');
  const env = {};
  // Keep executable discovery, locale and network trust/proxies, not user build/configuration knobs.
  for (const [key, value] of Object.entries(inherited)) {
    if (
      /^(PATH|LANG|LC_[A-Z_]+|TZ|https?_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i.test(
        key,
      )
    ) {
      env[key] = value;
    }
  }
  return Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    MITTER_HOME: path.join(work, 'state'),
    CI: 'true',
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    PNPM_HOME: path.join(work, 'pnpm-home'),
    COREPACK_HOME: path.join(work, 'corepack'),
    npm_config_cache: path.join(work, 'npm-cache'),
    npm_config_userconfig: path.join(home, '.npmrc'),
    npm_config_globalconfig: path.join(home, 'global.npmrc'),
    TMPDIR: path.join(work, 'tmp'),
    TMP: path.join(work, 'tmp'),
    TEMP: path.join(work, 'tmp'),
    MITER_FONT_FILE: path.join(work, 'FiraCodeNerdFontMono-Regular.ttf'),
    MITER_FONT_LICENSE: path.join(work, 'OFL.txt'),
  });
}

async function freshInstallDirectory(source, directory) {
  const temporary = await ownedTemporaryDirectory(path.resolve(directory));
  const work = path.join(temporary, 'work');

  for (const [parent, child] of [
    [source, work],
    [work, source],
  ]) {
    const relative = path.relative(parent, child);

    if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
      throw new Error(
        'Fresh-install source and work trees must not overlap. Use a separate temporary directory.',
      );
    }
  }

  const previous = await lstat(work).catch((error) => {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }

    return undefined;
  });

  if (previous !== undefined) {
    throw new Error(
      'Fresh-install work directory already exists. Use a fresh caller-owned temporary directory.',
    );
  }

  return temporary;
}

async function installSource(source, directory) {
  directory = await freshInstallDirectory(source, directory);
  const work = path.join(directory, 'work');
  const checkout = path.join(work, 'checkout');
  const env = freshInstallEnvironment(work);
  const log = path.join(directory, 'build.log');
  await mkdir(env.HOME, { recursive: true });
  await mkdir(env.TMPDIR);
  await mkdir(env.MITTER_HOME);
  console.log('Snapshotting source (PID ' + process.pid + '): ' + source);
  await snapshotSource(source, checkout);
  const policyFile = path.join(checkout, 'pnpm-workspace.yaml');
  const policy = await readFile(policyFile);
  console.log('Copying packaged build font inputs.');
  for (const [filename, destination] of [
    ['FiraCodeNerdFontMono-Regular.ttf', env.MITER_FONT_FILE],
    ['OFL.txt', env.MITER_FONT_LICENSE],
  ]) {
    const input = path.join(source, 'apps/extension/.output/chrome-mv3/fonts', filename);
    try {
      await copyFile(input, destination);
    } catch (error) {
      if (error instanceof Error && error.code === 'ENOENT') {
        throw new Error(
          'Missing packaged build font input: ' +
            input +
            '. Run pnpm build in ' +
            source +
            ' before fresh-install verification.',
          { cause: error },
        );
      }
      throw error;
    }
  }
  env.MITER_FONT_SHA256 = createHash('sha256')
    .update(await readFile(env.MITER_FONT_FILE))
    .digest('hex');
  await appendFile(
    log,
    `Source: ${source}\nNode: ${process.version}\nFont SHA256: ${env.MITER_FONT_SHA256}\nPolicy:\n${policy}`,
  );
  for (const [args, limit] of [
    [['scripts/setup.mjs', '--build-only'], 0],
    [['scripts/verify-build.mjs'], 30000],
  ]) {
    console.log('Running: node ' + args.join(' '));
    await appendFile(log, '\nCommand: node ' + args.join(' ') + '\n');
    // Do not detach: the outer runner owns this worker, its filesystem work and every build descendant.
    execFileSync(process.execPath, args, {
      cwd: checkout,
      env,
      stdio: 'inherit',
      timeout: limit,
      killSignal: 'SIGKILL',
    });
  }
  if (!(await readFile(policyFile)).equals(policy)) {
    throw new Error('Setup changed pnpm-workspace.yaml; age/build approval policy was not preserved.');
  }
  if (
    (await readdir(env.HOME, { recursive: true })).some((name) => name.includes('NativeMessagingHosts')) ||
    (await readdir(env.MITTER_HOME)).length !== 0
  ) {
    throw new Error('Build-only setup unexpectedly wrote host registration or Miter state.');
  }
  await appendFile(log, '\nPASS: real source-only setup and build verification completed.\n');
  console.log('PASS: real source-only setup and build verification completed.');
}

/** directory is caller-owned; remove work only after the worker closes and its group has been killed. */
export async function verifyFreshInstall({ source = root, directory, timeoutMs, signal }) {
  signal?.throwIfAborted();
  source = path.resolve(source);
  directory = await freshInstallDirectory(source, directory);
  const work = path.join(directory, 'work');
  const log = path.join(directory, 'build.log');
  console.log('Fresh-install logs: ' + log);
  try {
    await runBounded({
      cwd: root,
      // Ownership preflight needs the original temp root, not the not-yet-created build TMPDIR.
      // installSource gives every setup/build descendant the private work-tree environment.
      env: {
        ...freshInstallEnvironment(work),
        TMPDIR: os.tmpdir(),
        TMP: os.tmpdir(),
        TEMP: os.tmpdir(),
      },
      args: [fileURLToPath(import.meta.url), '--install-worker', source, directory],
      log,
      timeoutMs,
      signal,
    });
  } catch (error) {
    try {
      await appendFile(log, '\nFAIL: ' + String(error) + '\n');
    } catch (logError) {
      console.error('Could not record fresh-install failure in ' + log + ':', logError);
    }
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 3 });
    console.log('Removed temporary checkout, home, state, fonts and dependency caches.');
  }
}

async function freshInstall(timeoutMs) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Fresh install interrupted.'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mitter-fresh-install-'));
    await verifyFreshInstall({ directory, timeoutMs, signal: controller.signal });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

export function parseFreshInstallArguments(args) {
  const parsed = freshInstallArgumentsSchema.safeParse(args);

  if (!parsed.success) {
    throw new Error('Usage: node scripts/release-checks/fresh-install.mjs [--timeout-ms=1000..900000]', {
      cause: parsed.error,
    });
  }

  return parsed.data;
}

if (isMainModule(import.meta.url)) {
  try {
    const options = parseFreshInstallArguments(process.argv.slice(2));

    if (options.mode === 'worker') {
      await installSource(options.source, options.directory);
    } else {
      await freshInstall(options.timeoutMs);
    }
  } catch (error) {
    console.error('Fresh-install verification failed:', errorMessage(error));

    if (error instanceof Error && error.cause instanceof Error && typeof error.cause.code === 'string') {
      console.error('Underlying filesystem error:', error.cause.message);
    }

    process.exitCode = 1;
  }
}
