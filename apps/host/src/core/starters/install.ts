import { execFile } from 'node:child_process';
import type { BigIntStats } from 'node:fs';

// The child keeps the new directory as its kernel working directory. If another
// process renames or replaces it, individual writes cannot follow the replacement.
const writer = `
import fs from 'node:fs';
const directory = fs.statSync('.', { bigint: true });
if (directory.dev.toString() !== process.argv[1] || directory.ino.toString() !== process.argv[2]) {
  throw new Error('The new folder changed.');
}
if (fs.readdirSync('.').length) {
  throw new Error('The new folder is no longer empty.');
}
for (const [file, content] of JSON.parse(fs.readFileSync(0, 'utf8'))) {
  fs.writeFileSync(file, content, { flag: 'wx', mode: 0o644 });
}
`;

export async function installStarter(root: string, created: BigIntStats, files: ReadonlyMap<string, string>) {
  for (const file of files.keys()) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(file)) {
      throw new Error('The starter contains an invalid filename.');
    }
  }
  const payload = JSON.stringify([...files]);
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ['--input-type=module', '--eval', writer, created.dev.toString(), created.ino.toString()],
      { cwd: root, env: {}, timeout: 30_000, maxBuffer: 16 * 1024, windowsHide: true },
      (error) => {
        if (error) {
          reject(new Error('Starter files could not be written to the new empty folder.', { cause: error }));
        } else {
          resolve();
        }
      },
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(payload);
  });
}
