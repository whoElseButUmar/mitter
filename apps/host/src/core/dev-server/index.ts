import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { installDependencies } from './install.js';
import { prepareCompilerBindings } from './compiler-bindings.js';
import { removeScratch } from '../quality/sandbox.js';
import { launchProcess, runStage, waitForPage } from './process.js';
import { snapshotDevProject, type Framework } from './project.js';
import { runViteTypecheck } from './vite-typecheck.js';
export { detectDevProject, devProjectFingerprint } from './project.js';

export type DevServer = {
  framework: Framework;
  url: string;
  files: number;
  bytes: number;
  fingerprint: string;
  sourceRoot: string;
  portableCompilers?: string[];
  close(): Promise<void>;
  exited: Promise<void>;
};

async function availablePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }),
  );
  if (!address || typeof address === 'string') {
    throw new Error('Could not reserve a local preview port.');
  }
  return address.port;
}

async function launchOnAvailablePort(
  options: { cwd: string; scratch: string; executable: string; signal: AbortSignal; production: boolean },
  framework: Framework,
  entry: string,
  nextBundler: string[],
) {
  const base: string[] = [entry];
  if (framework === 'vite') {
    if (options.production) {
      base.push('preview');
    }
    base.push('--host', '127.0.0.1', '--strictPort');
  } else {
    if (options.production) {
      base.push('start');
    } else {
      base.push('dev', ...nextBundler);
    }
    base.push('--hostname', '127.0.0.1');
  }

  // Framework CLIs bind their own socket. Retry an actual bind collision once with a
  // different ephemeral port, keeping the installed dependencies and any production build.
  for (let attempt = 0; ; attempt++) {
    const port = await availablePort();
    const child = launchProcess({ ...options, args: [...base, '--port', String(port)], port });
    const url = 'http://127.0.0.1:' + port + '/';
    try {
      await waitForPage(url, child, options.signal);
      return { server: child, url };
    } catch (error) {
      await child.close();
      options.signal.throwIfAborted();
      if (attempt || !/EADDRINUSE|port \d+ is already in use/i.test(child.detail())) {
        throw error;
      }
    }
  }
}

export async function startDevServer(
  root: string,
  signal: AbortSignal,
  mode: 'development' | 'production' = 'development',
  onOutput?: (text: string) => void,
): Promise<DevServer> {
  if (process.platform !== 'darwin') {
    throw new Error('Managed framework servers require the macOS process sandbox.');
  }
  const snapshot = await snapshotDevProject(root, signal);
  signal.throwIfAborted();
  const node = await fs.realpath(process.execPath);
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'miter-framework-')));
  const install = path.join(scratch, 'install');
  const cwd = path.join(scratch, 'app');
  let child: ReturnType<typeof launchProcess> | undefined;
  try {
    await Promise.all(
      [install, cwd, path.join(scratch, 'home'), path.join(scratch, 'tmp')].map((dir) =>
        fs.mkdir(dir, { mode: 0o700 }),
      ),
    );
    const lock = snapshot.files.get('pnpm-lock.yaml');
    await installDependencies(scratch, snapshot.installManifest, lock, signal, onOutput);
    for (const [relative, bytes] of snapshot.files) {
      signal.throwIfAborted();
      const target = path.join(cwd, relative);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    await fs.rename(path.join(install, 'node_modules'), path.join(cwd, 'node_modules'));
    if (!lock) {
      await fs.copyFile(path.join(install, 'pnpm-lock.yaml'), path.join(cwd, 'pnpm-lock.yaml'));
    }
    const { framework } = snapshot;
    let bin = path.join(cwd, 'node_modules', 'vite', 'bin', 'vite.js');
    if (framework === 'next') {
      bin = path.join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next');
    }
    const entry = await fs.realpath(bin);
    if (!entry.startsWith(path.join(cwd, 'node_modules') + path.sep)) {
      throw new Error('The framework entry must belong to this install.');
    }
    const bindings = await prepareCompilerBindings(framework, scratch, cwd, signal, onOutput);
    let bundler = snapshot.nextBundler;
    if (bindings.webpack) {
      bundler = ['--webpack'];
    }
    const options = {
      cwd,
      scratch,
      executable: node,
      signal,
      production: mode === 'production',
      forceWasi: bindings.forceWasi,
      portable: bindings.names.length > 0,
      ...(bindings.preload && { preload: bindings.preload }),
      ...(onOutput && { onOutput }),
    };
    if (mode === 'production') {
      if (snapshot.viteTypecheckArgs) {
        await runViteTypecheck(options, snapshot.viteTypecheckArgs);
      }
      const build = [entry, 'build'];
      if (framework === 'next') {
        build.push(...bundler);
      }
      await runStage({ ...options, args: build }, framework + ' build', 180_000);
    }
    onOutput?.('Starting the ' + framework + ' server.\n');
    const { server, url } = await launchOnAvailablePort(options, framework, entry, bundler);
    child = server;
    const exited = server.finished.then(async () => {
      await removeScratch(scratch);
    });
    // Cleanup failure remains observable through close()/exited even when an owner
    // unsubscribes from process events during shutdown.
    void exited.catch(() => undefined);
    return {
      framework,
      url,
      files: snapshot.files.size,
      bytes: snapshot.bytes,
      fingerprint: snapshot.fingerprint,
      sourceRoot: cwd,
      ...(bindings.names.length && { portableCompilers: bindings.names }),
      exited,
      async close() {
        await server.close();
        await exited;
      },
    };
  } catch (error) {
    try {
      await child?.close();
    } finally {
      await removeScratch(scratch);
    }
    throw error;
  }
}
