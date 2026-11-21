import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { existing, listFiles } from '../workspace.js';
import { readPreviewBytes } from '../preview/snapshot.js';
import { previewSourceLimits } from '../../../../../packages/protocol/src/rpc/preview.js';

export type Framework = 'vite' | 'next';

const dependencyName = z
  .string()
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
const version = z
  .string()
  .min(1)
  .max(120)
  .regex(/^(?:[a-zA-Z][\w.-]*|[vV\d~^<>=*xX][\d\w .~^<>=*|+-]*)$/);
const dependencies = z
  .record(dependencyName, version)
  .optional()
  .describe('Published npm package names and registry versions or ranges.');
const packageSchema = z
  .object({
    scripts: z
      .object({
        dev: z.string().optional().describe('Framework development command.'),
        build: z.unknown().optional().describe('Build script inspected for supported TypeScript checks.'),
      })
      .optional()
      .describe('Project scripts.'),
    dependencies,
    devDependencies: dependencies,
    optionalDependencies: dependencies,
    peerDependencies: dependencies,
  })
  .describe('Standalone framework project and registry dependencies used for its managed installation.');

function frameworkFor(content: string): Framework | undefined {
  const manifest = z
    .object({
      scripts: z.object({ dev: z.string().optional() }).optional(),
      dependencies: z.record(z.string(), z.unknown()).optional(),
      devDependencies: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(JSON.parse(content));
  const command = manifest.scripts?.dev?.trim();
  if (!command) {
    return;
  }
  // The host supplies host, port and browser lifecycle itself. Never pass a model-authored shell string.
  if (
    /^vite(?:\s+(?:dev|serve))?(?:\s+(?:--host(?:[= ](?:localhost|127\.0\.0\.1|0\.0\.0\.0))?|--port[= ]\d+|--strictPort|--open))*$/.test(
      command,
    )
  ) {
    return 'vite';
  }
  if (
    /^next\s+dev(?:\s+(?:--webpack|--turbo(?:pack)?|(?:--hostname|-H)[= ](?:localhost|127\.0\.0\.1|0\.0\.0\.0)|(?:--port|-p)[= ]\d+))*$/.test(
      command,
    )
  ) {
    return 'next';
  }
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  if (
    /^(?:vite|next\s+dev)(?:\s|$)/.test(command) ||
    Object.hasOwn(declared, 'vite') ||
    Object.hasOwn(declared, 'next')
  ) {
    throw new Error(
      'Set scripts.dev to vite or next dev. Put framework options in the project configuration.',
    );
  }
  return;
}

export async function detectDevProject(root: string): Promise<Framework | undefined> {
  const manifest = await existing(root, 'package.json');
  if (manifest.content === null) {
    return;
  }
  return frameworkFor(manifest.content);
}

// Only app source and public assets enter the served project.
const discoveryDirectory = 'public/.well-known';
const sourceExtensions = new Set(
  'js jsx cjs mjs ts tsx mts cts vue svelte astro marko graphql gql glsl frag vert html htm css scss sass less styl stylus json jsonc svg png jpg jpeg webp gif ico avif bmp woff woff2 otf ttf wasm webmanifest txt md mdx yml yaml mp3 mp4 ogg wav webm csv'
    .split(' ')
    .map((ext) => '.' + ext),
);

function sourcePath(name: string): boolean {
  // A framework route or source module can itself be named cache.
  if (/^(?:cache|caches)(?:\/|$)/i.test(name)) {
    return false;
  }
  return !name
    .split('/')
    .some(
      (part) =>
        part.startsWith('.') ||
        /^(?:vendor|out|target)$/i.test(part) ||
        /(?:^|[-._])(?:secrets?|credentials?|private[-_]key)(?:[-._]|$)/i.test(part),
    );
}

function included(name: string): boolean {
  if (name === discoveryDirectory + '/ard.json') {
    return true;
  }
  if (!sourcePath(name)) {
    return false;
  }
  if (name === 'pnpm-lock.yaml') {
    return true;
  }
  if (
    /^(?:pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/i.test(path.posix.basename(name))
  ) {
    return false;
  }
  return name.startsWith('public/') || sourceExtensions.has(path.posix.extname(name).toLowerCase());
}

export async function snapshotDevProject(root: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const files = new Map<string, Buffer>();
  const limits = previewSourceLimits.framework;
  const names = await listFiles(
    root,
    '.',
    limits.files + 1,
    (reason) => {
      throw new Error(reason);
    },
    {
      visitDirectory: (name) => name === discoveryDirectory || sourcePath(name),
      includeFile: included,
      signal,
    },
  );
  if (names.length > limits.files) {
    throw new Error('A managed project can contain up to ' + limits.files + ' included source files.');
  }
  let bytes = 0;
  const hash = createHash('sha256');
  for (const name of names.sort()) {
    signal.throwIfAborted();
    const data = await readPreviewBytes(root, name, limits.fileBytes);
    bytes += data.length;
    if (bytes > limits.bytes) {
      throw new Error('Managed project source exceeds 128 MiB.');
    }
    files.set(name, data);
    hash.update(name).update('\0').update(createHash('sha256').update(data).digest());
  }
  const source = files.get('package.json')?.toString('utf8');
  if (!source) {
    throw new Error('The project needs a package.json with a Vite or Next.js dev script.');
  }
  const framework = frameworkFor(source);
  if (!framework) {
    throw new Error('The managed preview supports Vite and Next.js dev scripts.');
  }
  const manifest = packageSchema.safeParse(JSON.parse(source));
  if (!manifest.success) {
    throw new Error('Managed pnpm install needs public registry dependency names and versions.', {
      cause: manifest.error,
    });
  }
  const { scripts, ...groups } = manifest.data;
  if (!Object.values(groups).some((group) => group && Object.hasOwn(group, framework))) {
    throw new Error('Declare ' + framework + ' in package.json dependencies or devDependencies.');
  }
  let nextBundler: string[] = [];
  const bundler = scripts?.dev
    ?.split(/\s+/)
    .find((flag) => ['--webpack', '--turbo', '--turbopack'].includes(flag));
  if (framework === 'next' && bundler) {
    nextBundler = [bundler];
  }
  let viteTypecheckArgs: string[] | undefined;
  if (framework === 'vite' && typeof scripts?.build === 'string') {
    const recognized =
      /^tsc(?:[ \t]+(-b|--noEmit)|[ \t]+(?:-p|--project)[ \t]+(?:\.\/)?(tsconfig\.json))?[ \t]*&&[ \t]*vite[ \t]+build$/.exec(
        scripts.build.trim(),
      );
    if (recognized) {
      viteTypecheckArgs = [];
      if (recognized[1]) {
        viteTypecheckArgs.push(recognized[1]);
      } else if (recognized[2]) {
        viteTypecheckArgs.push('--project', 'tsconfig.json');
      }
    }
  }
  return {
    files,
    bytes,
    framework,
    nextBundler,
    viteTypecheckArgs,
    fingerprint: hash.digest('hex'),
    installManifest: JSON.stringify({ name: 'miter-preview', version: '0.0.0', private: true, ...groups }),
  };
}

export async function devProjectFingerprint(root: string, signal: AbortSignal): Promise<string> {
  return (await snapshotDevProject(root, signal)).fingerprint;
}
