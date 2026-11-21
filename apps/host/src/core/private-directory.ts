import { promises as fs } from 'node:fs';

/** Create a host-owned directory before allowing a sandboxed process to use it. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (await fs.realpath(directory)) !== directory
  ) {
    throw new Error('Miter needs a private directory owned by this user: ' + directory);
  }
}
