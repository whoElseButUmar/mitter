import { hasErrorCode } from '../types.js';
/** Native terminal dependency preflight. The macOS 1.1.0 package may contain a
 * non-executable spawn-helper (microsoft/node-pty#850 and #919). Repair is an
 * INSTALLER operation, never an agent action or a runtime side effect.
 *
 * node-pty v1.1.0/src/utils.ts loads Release, Debug, then the current prebuild;
 * we inspect require.cache AFTER its real loader has selected a binding. Do not
 * guess that the prebuilt helper is in use when a source build won precedence.
 */
import { z } from 'zod';
import { sha256Schema } from '../storage-schemas.js';
import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

export const EXPECTED_VERSION = '1.1.0';
const MAX_HELPER_BYTES = 16 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export class TerminalRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'TerminalRuntimeError';
  }
}

const failure = (code: string, message: string) => new TerminalRuntimeError(code, message);
const modeText = (mode: number) => (mode & 0o777).toString(8).padStart(3, '0');

export function inside(parent: string, child: string) {
  const relative = path.relative(parent, child);

  return (
    !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
  );
}

/** Exact layouts used by the pinned dependency, including its bundled layout. */

export function terminalBindingCandidates(packageRoot: string, platform: string, arch: string): string[] {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64', 'ia32', 'arm'].includes(arch)) {
    throw failure('PTY_PLATFORM', 'Unsupported terminal platform or architecture.');
  }

  return ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`].flatMap((directory) => [
    path.join(packageRoot, directory, 'pty.node'),
    path.join(packageRoot, 'lib', directory, 'pty.node'),
  ]);
}
/** Refuse links within the canonical dependency, rather than chmod-ing whatever
 * an installed helper symlink happens to reference. node_modules' normal pnpm
 * package symlink is resolved once by the loader before this boundary. */

async function regularMember(root: string, file: string) {
  if (!inside(root, file)) {
    throw failure('PTY_HELPER_PATH', 'Terminal helper is outside the resolved dependency.');
  }

  let current = root;
  const parts = path.relative(root, file).split(path.sep);

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];

    if (part === undefined) {
      throw failure('PTY_HELPER_PATH', 'Missing dependency path segment.');
    }
    current = path.join(current, part);
    let stat;

    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        throw failure(
          'PTY_HELPER_MISSING',
          `Missing terminal runtime file: ${path.relative(
            root,
            file,
          )}. Reinstall the candidate; do not skip the terminal test.`,
        );
      }

      throw error;
    }

    let ordinary = stat.isFile();

    if (index < parts.length - 1) {
      ordinary = stat.isDirectory();
    }

    if (stat.isSymbolicLink() || !ordinary) {
      throw failure(
        'PTY_HELPER_PATH',
        'Linked or non-regular terminal dependency file. Reinstall from a clean ' + 'candidate.',
      );
    }
  }
}

function cpuFor(arch: string) {
  if (arch === 'arm64') {
    return 0x0100000c;
  }

  if (arch === 'x64') {
    return 0x01000007;
  }

  throw failure('PTY_ARCH', 'Unsupported macOS process architecture: ' + arch);
}

function thinMachExecutable(bytes: Buffer, cpu: number) {
  return (
    bytes.length >= 32 &&
    bytes.readUInt32LE(0) === 0xfeedfacf &&
    bytes.readUInt32LE(4) === cpu &&
    bytes.readUInt32LE(12) === 2
  );
}
/** Require a Mach-O executable for this Node process, not a script with a known
 * filename. This is a format check, NOT a code-signature or malware verdict. */

export function isMachExecutable(bytes: Buffer, arch: string): boolean {
  const cpu = cpuFor(arch);

  if (thinMachExecutable(bytes, cpu)) {
    return true;
  }

  if (bytes.length < 8) {
    return false;
  }

  const magic = bytes.readUInt32BE(0);
  const fat64 = magic === 0xcafebabf;

  if (magic !== 0xcafebabe && !fat64) {
    return false;
  }

  const count = bytes.readUInt32BE(4);
  let size = 20;

  if (fat64) {
    size = 32;
  }

  if (count < 1 || count > 16 || 8 + count * size > bytes.length) {
    return false;
  }

  for (let index = 0; index < count; index++) {
    const headerOffset = 8 + index * size;

    if (bytes.readUInt32BE(headerOffset) !== cpu) {
      continue;
    }

    let offset: number;
    let length: number;

    if (fat64) {
      offset = Number(bytes.readBigUInt64BE(headerOffset + 8));
      length = Number(bytes.readBigUInt64BE(headerOffset + 16));
    } else {
      offset = bytes.readUInt32BE(headerOffset + 8);
      length = bytes.readUInt32BE(headerOffset + 12);
    }

    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 8 + count * size ||
      length < 32 ||
      offset + length > bytes.length
    ) {
      return false;
    }

    return thinMachExecutable(bytes.subarray(offset, offset + length), cpu);
  }

  return false;
}

export const helperCheckSchema = z
  .strictObject({
    helper: z.string().min(1).describe('The nonempty inspected canonical spawn-helper path.'),
    binding: z
      .string()
      .min(1)
      .describe('The nonempty exact native binding selected by the dependency loader.'),
    modeBefore: z
      .string()
      .regex(/^[0-7]{3}$/)
      .describe('Original ordinary permissions as exactly three octal digits.'),
    modeAfter: z
      .string()
      .regex(/^[0-7]{3}$/)
      .describe('Final ordinary permissions as exactly three octal digits.'),
    sha256: sha256Schema.describe('The checksum of the inspected helper bytes.'),
    repaired: z.boolean().describe('Whether an explicitly authorized local helper replacement occurred.'),
    sharedInode: z.boolean().describe('Whether the original helper had multiple filesystem hard links.'),
    architecture: z
      .enum(['arm64', 'x64'])
      .describe('The supported macOS process architecture used to check the Mach-O executable.'),
  })
  .describe(
    'Inspected native binding/helper identity, checksum, permissions and ' + 'installer-only repair.',
  );

export type HelperCheck = z.infer<typeof helperCheckSchema>;

export const helperOptionsSchema = z
  .strictObject({
    arch: z.string().describe('The Node process architecture; supported CPUs are checked before repair.'),
    repair: z
      .boolean()
      .optional()
      .describe('Only literal true authorizes installer-only helper replacement.'),
  })
  .describe('Explicit helper inspection options, never inferred from truthy configuration values.');

export type HelperOptions = z.infer<typeof helperOptionsSchema>;
/** Narrow exported filesystem operation for installer and regression fixtures.
 * The caller must already have loaded an approved pinned dependency. */

export async function checkDarwinHelper(
  packageRoot: string,
  binding: string,
  options: HelperOptions,
): Promise<HelperCheck> {
  const parsed = helperOptionsSchema.safeParse(options);

  if (!parsed.success) {
    throw new TerminalRuntimeError(
      'PTY_OPTIONS',
      'Invalid terminal helper options. No repair was attempted.',
      {
        cause: parsed.error,
      },
    );
  }

  options = parsed.data;
  packageRoot = await fs.realpath(packageRoot);
  binding = path.resolve(binding);

  if (!terminalBindingCandidates(packageRoot, 'darwin', options.arch).includes(binding)) {
    throw failure(
      'PTY_HELPER_PATH',
      'The loaded native binding has an unrecognized location. Nothing was ' + 'modified.',
    );
  }

  await regularMember(packageRoot, binding);
  const helper = path.join(path.dirname(binding), 'spawn-helper');
  await regularMember(packageRoot, helper);
  const initial = await fs.lstat(helper);

  if (initial.size < 32 || initial.size > MAX_HELPER_BYTES) {
    throw failure(
      'PTY_HELPER_FORMAT',
      'Terminal helper has an invalid size. Reinstall the approved dependency.',
    );
  }
  // Only the leaf is opened; parents were checked above. A shared pnpm store
  // inode is readable, but must NEVER be chmod-ed in place.
  const input = await fs.open(helper, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const stat = await input.stat();

    if (
      !stat.isFile() ||
      stat.ino !== initial.ino ||
      stat.dev !== initial.dev ||
      stat.size !== initial.size
    ) {
      throw failure('PTY_HELPER_CHANGED', 'Terminal helper changed during inspection. Nothing was modified.');
    }

    const bytes = await input.readFile();

    if (bytes.length !== stat.size || !isMachExecutable(bytes, options.arch)) {
      throw failure(
        'PTY_HELPER_ARCH',
        `spawn-helper is not a supported macOS ${
          options.arch
        } executable. Reinstall with the same Node architecture; no permission repair was attempted.`,
      );
    }

    if (stat.mode & 0o7000) {
      throw failure(
        'PTY_HELPER_MODE',
        'Terminal helper has unexpected special permission bits. Nothing was ' + 'modified.',
      );
    }

    const checksum = hash(bytes);
    const result = helperCheckSchema.parse({
      helper,
      binding,
      modeBefore: modeText(stat.mode),
      modeAfter: modeText(stat.mode),
      sha256: checksum,
      repaired: false,
      sharedInode: stat.nlink > 1,
      architecture: options.arch,
    });

    try {
      await fs.access(helper, constants.X_OK);

      return result;
    } catch (error) {
      if (!hasErrorCode(error, 'EACCES')) {
        throw error;
      }
    }

    if (stat.mode & 0o100) {
      throw failure(
        'PTY_HELPER_ACCESS',
        'spawn-helper already has owner execute permission but macOS denies ' +
          'access. Inspect filesystem/ACL/security settings; Miter will not ' +
          'change those settings.',
      );
    }

    if (!options.repair) {
      throw failure(
        'PTY_HELPER_NOT_EXECUTABLE',
        `node-pty ${EXPECTED_VERSION} spawn-helper is not executable (mode ${modeText(
          stat.mode,
        )}). From the Miter installation folder run: node scripts/prepare-terminal.mjs --repair. Then rerun installation. No terminal was started.`,
      );
    }

    if (typeof process.getuid !== 'function' || stat.uid !== process.getuid()) {
      throw failure(
        'PTY_HELPER_OWNER',
        'spawn-helper is not owned by the current user. Reinstall as your ' +
          'normal user; do not run Miter with sudo.',
      );
    }

    if (stat.mode & 0o022) {
      throw failure(
        'PTY_HELPER_MODE',
        'spawn-helper is writable by other users. Reinstall the dependency ' +
          'instead of making it executable.',
      );
    }

    const temporary = path.join(path.dirname(helper), `.miter-spawn-helper-${randomUUID()}.tmp`);
    let staged = false;

    try {
      const copy = await fs.open(
        temporary,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      staged = true;

      try {
        if (process.platform === 'darwin') {
          // Apple's cp -p preserves ACLs, flags and extended attributes (including
          // quarantine). Do not silently strip security metadata via a byte-only
          // copy. No shell, PATH lookup or inherited COPYFILE_DISABLE setting.
          await execFileAsync('/bin/cp', ['-p', helper, temporary], {
            timeout: 10000,
            maxBuffer: 64 * 1024,
            env: {
              PATH: '/usr/bin:/bin',
              LC_ALL: 'C',
            },
          });
          const copied = await fs.lstat(temporary);
          const held = await copy.stat();

          if (
            !copied.isFile() ||
            copied.isSymbolicLink() ||
            copied.nlink !== 1 ||
            copied.ino !== held.ino ||
            copied.dev !== held.dev ||
            hash(await copy.readFile()) !== checksum
          ) {
            throw failure(
              'PTY_HELPER_CHANGED',
              'Attribute-preserving helper copy changed unexpectedly. Nothing was ' + 'published.',
            );
          }
        } else {
          await copy.writeFile(bytes);
        } // Unix filesystem fixtures, not a macOS launch.
        await copy.chmod((stat.mode & 0o777) | 0o100);
        await copy.sync();
      } finally {
        await copy.close();
      }

      await regularMember(packageRoot, helper);
      const latest = await fs.lstat(helper);

      if (
        latest.ino !== stat.ino ||
        latest.dev !== stat.dev ||
        latest.size !== stat.size ||
        latest.mtimeMs !== stat.mtimeMs ||
        latest.ctimeMs !== stat.ctimeMs ||
        hash(await fs.readFile(helper)) !== checksum
      ) {
        throw failure(
          'PTY_HELPER_CHANGED',
          'Terminal helper changed before publication. The repair was cancelled.',
        );
      }

      if (hash(await fs.readFile(temporary)) !== checksum) {
        throw failure(
          'PTY_HELPER_CHANGED',
          'Terminal helper copy failed verification. The repair was cancelled.',
        );
      }
      // Replacing only the local directory entry protects the pnpm store and
      // every other installation even if the original was hardlinked.
      await fs.rename(temporary, helper);
      staged = false;
      const final = await fs.lstat(helper);
      await fs.access(helper, constants.X_OK);

      if (
        final.isSymbolicLink() ||
        !final.isFile() ||
        final.nlink !== 1 ||
        hash(await fs.readFile(helper)) !== checksum
      ) {
        throw failure('PTY_HELPER_CHANGED', 'Repaired helper verification failed. Installation must stop.');
      }

      return helperCheckSchema.parse({
        ...result,
        modeAfter: modeText(final.mode),
        repaired: true,
      });
    } finally {
      if (staged) {
        await fs.unlink(temporary).catch(() => {});
      }
    }
  } finally {
    await input.close();
  }
}
