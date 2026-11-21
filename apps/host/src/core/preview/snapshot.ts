import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { previewSourceLimits } from '../../../../../packages/protocol/src/rpc/preview.js';
import { existing, fileText, safePath, validateRelative } from '../workspace.js';
import { hasErrorCode } from '../types.js';
import { javascriptReferences } from './module-references.js';

export const MAX_PREVIEW_FILES = previewSourceLimits.static.files;
export const MAX_PREVIEW_BYTES = previewSourceLimits.static.bytes;
const mimeTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export type PreviewAsset = { bytes: Buffer; mime: string };
export type BackendSnapshot = { entry: string; files: ReadonlyMap<string, string> };
export type PreviewSnapshot = {
  entry?: string;
  assets: ReadonlyMap<string, PreviewAsset>;
  bytes: number;
  backend?: BackendSnapshot;
};

export function staticPreviewFingerprint(snapshot: PreviewSnapshot): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(['html-entry', snapshot.entry ?? 'index.html']));
  for (const [name, asset] of [...snapshot.assets].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([name, createHash('sha256').update(asset.bytes).digest('hex')]));
  }
  if (snapshot.backend) {
    hash.update(JSON.stringify(['backend-entry', snapshot.backend.entry]));
    for (const [name, source] of [...snapshot.backend.files].sort(([a], [b]) => a.localeCompare(b))) {
      hash.update(JSON.stringify(['backend-file', name, createHash('sha256').update(source).digest('hex')]));
    }
  }
  return hash.digest('hex');
}

const modulePath = z
  .string()
  .min(1)
  .max(1000)
  .regex(/\.(?:js|cjs|mjs)$/)
  .describe('A project-relative Node module path.');
const backendManifest = z
  .strictObject({
    entry: modulePath,
    files: z
      .array(modulePath)
      .max(31)
      .optional()
      .describe('Additional private modules imported by the handler.'),
  })
  .describe('Declares a dependency-free HTTP handler and its source files.');

async function snapshotBackend(root: string, signal: AbortSignal): Promise<BackendSnapshot | undefined> {
  const manifest = await existing(root, 'miter.backend.json');
  if (manifest.content === null) {
    return undefined;
  }
  const { entry, files: dependencies } = backendManifest.parse(JSON.parse(manifest.content));
  const files = new Map<string, string>();
  const names = new Set<string>();
  for (const name of [entry, ...(dependencies ?? [])]) {
    signal.throwIfAborted();
    validateRelative(name);
    const key = name.normalize('NFC').toLowerCase();
    if (names.has(key) || name.split('/').some((part) => part.startsWith('.'))) {
      throw new Error('Use distinct, visible relative module paths in miter.backend.json.');
    }
    names.add(key);
    files.set(name, (await fileText(root, name)).content);
  }
  return { entry, files };
}

export function publicAssetPath(relative: string): string {
  validateRelative(relative);
  if (
    relative
      .split('/')
      .some(
        (part) =>
          part.startsWith('.') ||
          /(?:^|[._-])(?:test|tests|spec|specs|config|secret|secrets|credentials|private|server|backend)(?:[._-]|$)/i.test(
            part,
          ) ||
          /^(?:readme|license|package|pnpm-lock|yarn|miter\.quality)(?:[._-]|$)/i.test(part),
      )
  ) {
    throw new Error('Static preview excludes private, server, test and configuration files: ' + relative);
  }
  if (!mimeTypes[path.posix.extname(relative).toLowerCase()]) {
    throw new Error('Static preview cannot serve this file type: ' + relative + '. Use a built static app.');
  }
  return relative;
}

function resourcePath(from: string, value: string, module = false): string | undefined {
  const reference = value.trim().replace(/&amp;/g, '&');
  if (!reference || reference.startsWith('#')) {
    return undefined;
  }
  if (!module && /^data:(?:image|font|audio|video)\//i.test(reference)) {
    return undefined;
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(reference) || /[\\\x00-\x1f]/.test(reference)) {
    throw new Error(
      'Static preview needs relative local assets; remote, root-relative and backend URLs are unsupported: ' +
        reference.slice(0, 160),
    );
  }
  if (module && !reference.startsWith('./') && !reference.startsWith('../')) {
    throw new Error('Bare module imports need a frontend build before preview: ' + reference.slice(0, 160));
  }
  const pathname = reference.split(/[?#]/)[0];
  if (!pathname) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new Error('A static asset URL has invalid percent encoding.');
  }
  if (/[\\\x00-\x1f]/.test(decoded) || decoded.startsWith('/')) {
    throw new Error('Unsafe static asset URL.');
  }
  return publicAssetPath(path.posix.normalize(path.posix.join(path.posix.dirname(from), decoded)));
}

function stripComments(source: string, opening: string, closing: string): string {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(opening, cursor);
    if (start < 0) {
      parts.push(source.slice(cursor));
      break;
    }
    parts.push(source.slice(cursor, start), ' ');
    const end = source.indexOf(closing, start + opening.length);
    if (end < 0) {
      break;
    }
    cursor = end + closing.length;
  }
  return parts.join('');
}

function dependencies(relative: string, source: string, allowBackend: boolean): string[] {
  const found = new Set<string>();
  const add = (value: string, module = false) => {
    const resolved = resourcePath(relative, value, module);
    if (resolved) {
      found.add(resolved);
    }
  };
  const script = (value: string) => {
    for (const reference of javascriptReferences(value, allowBackend)) {
      add(reference, true);
    }
  };
  const css = (value: string) => {
    const content = stripComments(value, '/*', '*/');
    for (const match of content.matchAll(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)|@import\s+['"]([^'"]+)['"]/gi,
    )) {
      add(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '');
    }
  };
  if (/\.m?js$/i.test(relative)) {
    script(source);
  } else if (/\.css$/i.test(relative)) {
    css(source);
  } else if (/\.html?$/i.test(relative)) {
    const html = stripComments(source, '<!--', '-->');
    if (
      /<(?:base|iframe|object|embed)\b/i.test(html) ||
      /<script\b[^>]*\btype\s*=\s*['"]?importmap/i.test(html)
    ) {
      throw new Error('Embedded pages, base URLs and import maps are unsupported in static preview.');
    }
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      script(match[1] ?? '');
    }
    for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
      css(match[1] ?? '');
    }
    for (const match of html.matchAll(/<(?:script|link|img|source|video|audio|track|input)\b[^>]*>/gi)) {
      for (const attribute of match[0].matchAll(
        /\b(src|href|poster|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      )) {
        const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
        if (attribute[1]?.toLowerCase() === 'srcset') {
          for (const candidate of value.split(',')) {
            add(candidate.trim().split(/\s+/)[0] ?? '');
          }
        } else {
          add(value);
        }
      }
    }
    for (const match of html.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      css(match[1] ?? match[2] ?? '');
    }
  }
  return [...found];
}

export async function readPreviewBytes(
  root: string,
  relative: string,
  maxBytes: number = previewSourceLimits.static.fileBytes,
): Promise<Buffer> {
  const target = await safePath(root, relative);
  const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) {
      throw new Error(
        'Preview assets must be ordinary unlinked files of at most ' +
          maxBytes / (1024 * 1024) +
          ' MiB: ' +
          relative,
      );
    }
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) {
        break;
      }
      offset += result.bytesRead;
    }
    const after = await file.stat();
    const current = await fs.stat(await safePath(root, relative));
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev
    ) {
      throw new Error('A project file changed while loading. Run the app again: ' + relative);
    }
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function readAsset(root: string, relative: string): Promise<PreviewAsset> {
  const bytes = await readPreviewBytes(root, publicAssetPath(relative));
  const mime = mimeTypes[path.posix.extname(relative).toLowerCase()];
  if (!mime) {
    throw new Error('Unsupported preview file type.');
  }
  return { bytes, mime };
}

export async function snapshotApp(
  root: string,
  signal: AbortSignal,
  entry = 'index.html',
): Promise<PreviewSnapshot> {
  signal.throwIfAborted();
  const backend = await snapshotBackend(root, signal);
  const privateNames = new Set(
    Array.from(backend?.files.keys() ?? [], (name) => name.normalize('NFC').toLowerCase()),
  );
  const assets = new Map<string, PreviewAsset>();
  const pending = [publicAssetPath(entry)];
  const queued = new Set(pending);
  let bytes = 0;
  while (pending.length > 0) {
    signal.throwIfAborted();
    const relative = pending.shift();
    if (!relative) {
      break;
    }
    if (privateNames.has(relative.normalize('NFC').toLowerCase())) {
      throw new Error('Backend source cannot also be linked as a browser asset: ' + relative);
    }
    let asset: PreviewAsset;
    try {
      asset = await readAsset(root, relative);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        let detail =
          'The app links to a missing file: ' +
          relative +
          '. Restore or build that file, then run the app again.';
        if (relative === 'index.html') {
          detail =
            'No index.html was found in the project folder. Preview needs a built static app. Use the project’s development command for a framework or backend app.';
        }
        throw new Error(detail, { cause: error });
      }
      throw error;
    }
    signal.throwIfAborted();
    bytes += asset.bytes.length;
    if (bytes > MAX_PREVIEW_BYTES) {
      throw new Error('Static preview is limited to 24 MiB of linked assets.');
    }
    assets.set(relative, asset);
    if (/\.(?:html?|css|m?js)$/i.test(relative)) {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(asset.bytes);
      for (const dependency of dependencies(relative, source, Boolean(backend))) {
        if (!queued.has(dependency)) {
          queued.add(dependency);
          if (queued.size > MAX_PREVIEW_FILES) {
            throw new Error('Static preview is limited to 256 linked assets.');
          }
          pending.push(dependency);
        }
      }
    }
  }
  if (backend) {
    return { entry, assets, bytes, backend };
  }
  return { entry, assets, bytes };
}
