import { constants } from 'node:fs';
import { mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { RedactedOutput } from '../redaction.js';
import { managedPnpmExecutable } from '../managed-pnpm.js';
import { hasErrorCode } from '../types.js';

export type ManualSetupResult = { code: number | null; output: string; plainPnpmInstall?: true };
export type ManualSetupOptions = {
  workerId: string;
  projectId: string;
  root: string;
  signal: AbortSignal;
  onFinish: (sessionId: string, result: ManualSetupResult) => void;
};

const reportSchema = z
  .strictObject({
    code: z.int().nullable().describe('Exit code observed by the one-command terminal.'),
    plainPnpmInstall: z
      .literal(true)
      .optional()
      .describe('The helper ran the bundled pnpm install directly.'),
    stdout: z.string().max(8300).describe('Bounded output from the child process stdout pipe.'),
    stderr: z.string().max(8300).describe('Bounded output from the child process stderr pipe.'),
  })
  .describe('The completed command report from this terminal, excluding keyboard input.');

function cleanOutput(text: string): string {
  let output = '';
  const filter = new RedactedOutput((line) => {
    output += line;
  });
  filter.push(Buffer.from(stripVTControlCharacters(text).replace(/\r/g, '\n')));
  filter.end();
  return output.trim();
}

/** Hold the original file open. Even a replacement at its path cannot redirect the read. */
export async function prepareManualReport() {
  const directory = await mkdtemp(path.join(tmpdir(), 'miter-command-'));
  const file = path.join(directory, 'result');
  const handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600).catch(
    async (error: unknown) => {
      await rmdir(directory);
      throw error;
    },
  );
  return {
    file,
    async result(exitCode: number | null): Promise<ManualSetupResult> {
      const missing = { code: null, output: 'The terminal closed before the command reported its result.' };
      if (exitCode === null) {
        return missing;
      }
      // Two 8 KiB streams can expand up to sixfold when JSON escapes control characters.
      const size = (await handle.stat()).size;
      if (!size || size > 100_000) {
        return missing;
      }
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      if (bytesRead !== size) {
        return missing;
      }
      const report = reportSchema.parse(JSON.parse(buffer.toString('utf8')));
      if (report.code !== null && report.code !== exitCode) {
        return missing;
      }
      const output = [cleanOutput(report.stdout), cleanOutput(report.stderr)].filter(Boolean).join('\n');
      return {
        code: report.code,
        output,
        ...(report.code === 0 && report.plainPnpmInstall && { plainPnpmInstall: true }),
      };
    },
    async close() {
      try {
        await handle.close();
      } finally {
        await unlink(file).catch((error: unknown) => {
          if (!hasErrorCode(error, 'ENOENT')) {
            throw error;
          }
        });
        await rmdir(directory);
      }
    },
  };
}

export function manualSetupLaunch(shell: string, file: string, existingPath: string | undefined) {
  const helper = path.join(import.meta.dirname, 'manual-entry' + path.extname(import.meta.filename));
  const tools: string[] = [];
  const args = [helper, shell, file];
  if (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) {
    try {
      const pnpm = managedPnpmExecutable();
      tools.push(path.dirname(pnpm));
      args.push(pnpm);
    } catch (error) {
      if (!hasErrorCode(error, 'MODULE_NOT_FOUND') && !hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
  }
  tools.push(path.dirname(process.execPath));
  if (existingPath) {
    tools.push(existingPath);
  }
  return { program: process.execPath, args, path: tools.join(path.delimiter) };
}
