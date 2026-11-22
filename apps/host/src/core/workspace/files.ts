import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { MAX_TEXT } from '../../../../../packages/protocol/src/index.js';
import { MAX_IMAGE_BYTES } from '../../../../../packages/protocol/src/schemas/image-attachments.js';
import { hasErrorCode, isRecord } from '../types.js';
import { digest, staleEdit } from '../edit-plan.js';
import type { FileVersion } from '../edit-plan.js';
import { z } from 'zod';
import type { FileText } from '../../../../../packages/protocol/src/rpc.js';
export { fileTextSchema } from '../../../../../packages/protocol/src/rpc.js';
export type { FileText } from '../../../../../packages/protocol/src/rpc.js';

export const searchMatchSchema = z
  .object({
    path: z.string().describe('The confined project-relative path containing the match.'),
    line: z.number().int().positive().describe('The one-based source line number of the match.'),
    text: z.string().describe('The matched line, clipped to the bounded search display length.'),
  })
  .describe('A bounded literal source search match.');

export type SearchMatch = z.infer<typeof searchMatchSchema>;
const denied = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.mitter',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
]);

export class ExcludedPathError extends Error {}
export class DirectoryReadError extends Error {}

export function validateRelative(input: string, allowRoot = false): string {
  if (input === '.' && allowRoot) {
    return input;
  }

  if (
    !input ||
    input.length > 1000 ||
    /[\\\0:\x00-\x1f]/.test(input) ||
    input.startsWith('/') ||
    path.win32.isAbsolute(input)
  ) {
    throw new Error('Use a relative project path with forward slashes.');
  }

  const segments = input.split('/');

  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        /[. ]$/.test(segment) ||
        /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(segment),
    )
  ) {
    throw new Error('Unsafe path segment.');
  }

  if (
    segments.some(
      (segment) =>
        denied.has(segment.toLowerCase()) ||
        segment.toLowerCase().startsWith('.env') ||
        /\.(pem|key|p12|pfx)$/i.test(segment),
    )
  ) {
    throw new ExcludedPathError('Sensitive or excluded path.');
  }

  return input;
}

export async function canonicalRoot(input: string): Promise<string> {
  if (!path.isAbsolute(input)) {
    throw new Error('Project root must be an absolute path.');
  }

  const root = await fs.realpath(input);
  const home = await fs.realpath(os.homedir());

  if (root === path.parse(root).root || root === home) {
    throw new Error('Select a project folder, not your home folder or a drive root.');
  }

  const stat = await fs.stat(root);

  if (!stat.isDirectory()) {
    throw new Error('Project root is not a folder.');
  }

  return root;
}

export function overlaps(firstRoot: string, secondRoot: string): boolean {
  if (process.platform === 'win32') {
    firstRoot = firstRoot.toLowerCase();
    secondRoot = secondRoot.toLowerCase();
  }

  return (
    firstRoot === secondRoot ||
    firstRoot.startsWith(secondRoot + path.sep) ||
    secondRoot.startsWith(firstRoot + path.sep)
  );
}
/** Reject symlinks along the complete path. This is defense in depth, not an OS sandbox. */

export async function safePath(root: string, relative: string, allowRoot = false): Promise<string> {
  validateRelative(relative, allowRoot);

  if ((await fs.realpath(root)) !== root) {
    throw new Error('Project root changed. Re-register it.');
  }

  let current = root;

  if (relative === '.') {
    return root;
  }

  let missing = false;

  for (const part of relative.split('/')) {
    current = path.join(current, part);

    if (missing) {
      continue;
    }

    try {
      const stat = await fs.lstat(current);

      if (stat.isSymbolicLink()) {
        throw new Error('Symbolic links are not allowed.');
      }

      if (stat.isFile() && stat.nlink > 1) {
        throw new Error('Hard-linked files are not allowed.');
      }

      if (!stat.isFile() && !stat.isDirectory()) {
        throw new Error('Special files are not allowed.');
      }
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        missing = true;
      } else {
        throw error;
      }
    }
  }

  return current;
}

/** Only absence of the exact requested child is an ordinary task observation.
 * A failed root, traversal, or disappearing entry during a recursive scan must surface. */
export async function isMissingProjectPath(root: string, relative: string, error: unknown): Promise<boolean> {
  if (
    relative === '.' ||
    !isRecord(error) ||
    error.code !== 'ENOENT' ||
    error.path !== path.join(root, relative)
  ) {
    return false;
  }
  const target = await safePath(root, relative);
  try {
    await fs.lstat(target);
    return false;
  } catch (current) {
    if (hasErrorCode(current, 'ENOENT')) {
      return true;
    }
    throw current;
  }
}

export async function fileText(root: string, relative: string): Promise<FileText> {
  const target = await safePath(root, relative);
  // O_NOFOLLOW binds the descriptor to the inode that existed at open time, so
  // a symlink swapped in after safePath() cannot be followed. fstat re-verifies
  // the opened inode itself: regular, unlinked, within the size budget.
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));

  try {
    const stat = await handle.stat();

    if (stat.isDirectory()) {
      throw new DirectoryReadError('This path is a directory. Use list to inspect its files.');
    }

    if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_TEXT) {
      throw new Error('Read limited to ordinary, unlinked UTF-8 files of at most 120 KB.');
    }

    const bytes = await handle.readFile();

    if (bytes.length > MAX_TEXT) {
      throw new Error('File grew beyond the read limit.');
    }

    if (bytes.includes(0)) {
      throw new Error('Binary files are not supported.');
    }

    const content = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);

    return {
      content,
      hash: digest(content),
    };
  } finally {
    await handle.close();
  }
}

export async function existing(root: string, relative: string): Promise<FileVersion> {
  try {
    return await fileText(root, relative);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return {
        content: null,
        hash: 'missing',
      };
    }

    throw error;
  }
}

/** Read only the digest for a binary file; model text reads remain unchanged. */
export async function imageFileHash(root: string, relative: string): Promise<string> {
  const target = await safePath(root, relative);
  try {
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_IMAGE_BYTES) {
        throw new Error('Image checks require an ordinary, unlinked file up to 5 MiB.');
      }
      const bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) {
          break;
        }
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (offset !== stat.size || after.size !== stat.size || after.ctimeMs !== stat.ctimeMs) {
        throw new Error('The image changed during the file check. Try again.');
      }
      return digest(bytes.subarray(0, offset));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return 'missing';
    }
    throw error;
  }
}

export async function listFiles(
  root: string,
  relative = '.',
  max = 300,
  onOmittedPath?: (reason: string) => void,
  selection?: {
    visitDirectory: (relative: string) => boolean;
    includeFile: (relative: string) => boolean;
    signal: AbortSignal;
  },
): Promise<string[]> {
  const start = await safePath(root, relative, true);
  const output: string[] = [];
  async function visit(directory: string, depth: number) {
    selection?.signal.throwIfAborted();
    if (depth > 8) {
      onOmittedPath?.('The project exceeds the snapshot depth limit. No partial source copy was tested.');
      return;
    }
    if (output.length >= max) {
      return;
    }

    const entries = await fs.readdir(directory, {
      withFileTypes: true,
    });
    entries.sort((firstEntry, secondEntry) => firstEntry.name.localeCompare(secondEntry.name));

    for (const entry of entries) {
      if (output.length >= max) {
        return;
      }

      const absolute = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolute).split(path.sep).join('/');

      try {
        validateRelative(relativePath);
      } catch {
        continue;
      }

      if (entry.isSymbolicLink()) {
        onOmittedPath?.('A symbolic link cannot be copied into the isolated test snapshot.');
        continue;
      }

      if (entry.isDirectory()) {
        if (
          ['dist', 'build', 'coverage', '.next'].includes(entry.name) ||
          (selection && !selection.visitDirectory(relativePath))
        ) {
          continue;
        }

        await visit(absolute, depth + 1);
      } else if (entry.isFile()) {
        if (!selection || selection.includeFile(relativePath)) {
          output.push(relativePath);
        }
      } else {
        onOmittedPath?.('A special file cannot be copied into the isolated test snapshot.');
      }
    }
  }

  await visit(start, 0);

  return output;
}

export async function searchFiles(root: string, query: string): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];

  for (const relative of await listFiles(root, '.', 300)) {
    try {
      const { content } = await fileText(root, relative);
      const lines = content.split('\n');

      for (let lineIndex = 0; lineIndex < lines.length && matches.length < 40; lineIndex++) {
        const line = lines[lineIndex];

        if (line !== undefined && line.includes(query)) {
          matches.push({
            path: relative,
            line: lineIndex + 1,
            text: line.slice(0, 300),
          });
        }
      }

      if (matches.length >= 40) {
        break;
      }
    } catch {
      /* unreadable/binary/oversized files are never fed into a model */
    }
  }

  return matches;
}

export async function atomicWrite(
  root: string,
  relative: string,
  content: string | Uint8Array,
  expectedHash?: string,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof content !== 'string' && expectedHash !== 'missing') {
    throw new Error('Images can only be written to new files.');
  }
  const currentHash = async () => {
    if (typeof content === 'string') {
      return (await existing(root, relative)).hash;
    }
    return imageFileHash(root, relative);
  };

  const target = await safePath(root, relative);
  signal?.throwIfAborted();
  await fs.mkdir(path.dirname(target), {
    recursive: true,
  });
  await safePath(root, relative);
  let mode = 0o600;

  try {
    mode = (await fs.stat(target)).mode & 0o777;
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }

  const temporary = path.join(path.dirname(target), `.mitter-tmp-${randomUUID()}`);

  try {
    const handle = await fs.open(temporary, 'wx', mode);

    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await safePath(root, relative);

    if (expectedHash !== undefined) {
      const hash = await currentHash();

      if (hash !== expectedHash) {
        throw staleEdit(relative, expectedHash, hash);
      }
    }

    signal?.throwIfAborted();
    if (expectedHash === 'missing') {
      // Exclusive publication: a concurrently created target must not be replaced.

      try {
        await fs.link(temporary, target);
      } catch (error) {
        if (hasErrorCode(error, 'EEXIST')) {
          throw staleEdit(relative, 'missing', await currentHash());
        }

        throw error;
      }
    } else {
      await fs.rename(temporary, target);
    }
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
