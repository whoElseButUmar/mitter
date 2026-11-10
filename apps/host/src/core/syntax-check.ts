import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileText } from './workspace.js';
import { runCommand } from './commands.js';
import type { SyntaxCheck } from '../../../../packages/protocol/src/rpc.js';
export { syntaxCheckSchema } from '../../../../packages/protocol/src/rpc.js';
export type { SyntaxCheck } from '../../../../packages/protocol/src/rpc.js';
/** Explicit user tool. --check parses a copied source; it never runs that script
 * or reads its project's package.json/loaders. Not a browser/gameplay test. */

export async function checkJavaScript(
  root: string,
  relative: string,
  dataDir: string,
  signal: AbortSignal,
): Promise<SyntaxCheck> {
  if (!/\.(?:js|mjs|cjs)$/.test(relative)) {
    throw new Error('Syntax checking supports .js, .mjs and .cjs files.');
  }

  const source = await fileText(root, relative);
  const scratch = path.join(dataDir, 'syntax', randomUUID());
  await fs.mkdir(scratch, {
    recursive: true,
    mode: 0o700,
  });
  let extension = '.mjs';

  if (path.extname(relative) === '.cjs') {
    extension = '.cjs';
  }

  const target = path.join(scratch, 'source' + extension);

  try {
    await fs.writeFile(target, source.content, {
      mode: 0o600,
    });
    const result = await runCommand(
      {
        id: 'syntax',
        label: 'JavaScript syntax',
        program: process.execPath,
        args: ['--check', target],
        timeoutMs: 5000,
      },
      scratch,
      scratch,
      signal,
    );

    return {
      path: relative,
      hash: source.hash,
      ok: result.code === 0 && !result.aborted && !result.timedOut,
      code: result.code,
      details: result.stderr.replaceAll(target, relative).slice(0, 8000),
      scope: 'Syntax only; this did not run your program or test browser behavior.',
    };
  } finally {
    await fs.rm(scratch, {
      recursive: true,
      force: true,
    });
  }
}
