import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { safePath } from './workspace.js';
import { desktopExec } from './desktop.js';
import type { AssetChunk, OpenedResult } from '../../../../packages/protocol/src/rpc.js';
export { assetChunkSchema } from '../../../../packages/protocol/src/rpc.js';
export type { AssetChunk } from '../../../../packages/protocol/src/rpc.js';
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export const assetMime = (file: string) => MIME[path.extname(file).toLowerCase()] || 'text/plain';

export const MAX_PREVIEW_BYTES = 24 * 1024 * 1024;
/** Independent preview/read permission, constrained to the task's filesystem root.
 * Every chunk carries the same file stamp. No trusting a stale path or symlink. */

export async function readAsset(
  root: string,
  relative: string,
  offset = 0,
  length = 192000,
  expected?: string,
): Promise<AssetChunk> {
  const target = await safePath(root, relative);
  const fd = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));

  try {
    const before = await fd.stat();

    if (!before.isFile() || before.nlink > 1) {
      throw new Error('Preview requires an ordinary, unlinked file.');
    }

    if (before.size > MAX_PREVIEW_BYTES) {
      throw new Error('This file exceeds the 24 MB preview limit. Open it in its desktop ' + 'application.');
    }

    const stamp = createHash('sha256')
      .update([before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(':'))
      .digest('hex');

    if (expected && expected !== stamp) {
      throw new Error('The file changed while loading its preview. Reload it.');
    }

    if (offset > before.size) {
      throw new Error('Invalid preview offset.');
    }

    const buffer = Buffer.alloc(Math.min(length, before.size - offset));
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, offset);
    const after = await fd.stat();

    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size || after.ctimeMs !== before.ctimeMs) {
      throw new Error('The file changed while reading. Reload it.');
    }

    return {
      path: relative,
      mime: assetMime(relative),
      size: before.size,
      offset,
      stamp,
      data: buffer.subarray(0, bytesRead).toString('base64'),
      eof: offset + bytesRead >= before.size,
    };
  } finally {
    await fd.close();
  }
}

export async function openTaskFile(
  root: string,
  relative: string,
  application: 'finder' | 'vscode',
): Promise<OpenedResult> {
  const target = await safePath(root, relative);
  await fs.access(target);

  if (application === 'vscode') {
    if (process.platform === 'darwin') {
      await desktopExec({
        program: '/usr/bin/open',
        args: ['-a', 'Visual Studio Code', target],
      });
    } else if (process.platform === 'win32') {
      const file = target.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
      await desktopExec({
        program: path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'),
        args: ['vscode://file/' + file],
      });
    } else {
      await desktopExec({
        program: 'code',
        args: ['--reuse-window', target],
      });
    }
  } else if (process.platform === 'darwin') {
    await desktopExec({
      program: '/usr/bin/open',
      args: ['-R', target],
    });
  } else if (process.platform === 'win32') {
    await desktopExec({
      program: path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'),
      args: ['/select,' + target],
    });
  } else {
    await desktopExec({
      program: 'xdg-open',
      args: [path.dirname(target)],
    });
  }

  return {
    opened: true,
  };
}
