import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

// Only child pipes are copied. PTY echo, the typed command and prompt answers stay local.
function copyOutput(stream: Readable, terminal: Writable) {
  const limit = 8192;
  const bytes: Buffer[] = [];
  let length = 0;
  let truncated = false;
  stream.on('data', (chunk: Buffer) => {
    const take = Math.min(chunk.length, limit - length);
    if (take > 0) {
      bytes.push(Buffer.from(chunk.subarray(0, take)));
      length += take;
    }
    truncated ||= take < chunk.length;
  });
  stream.pipe(terminal, { end: false });
  return () => {
    const text = Buffer.concat(bytes).toString('utf8');
    if (truncated) {
      return text.slice(0, text.lastIndexOf('\n') + 1) + '[Further output omitted]';
    }
    return text;
  };
}

async function readCommand() {
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 0,
  });
  const close = () => input.close();
  input.on('SIGINT', close);
  let interactive = false;
  try {
    input.setPrompt('Setup command › ');
    input.prompt();
    for await (const line of input) {
      if (line.trim() === ':interactive') {
        interactive = true;
        process.stdout.write('Full terminal mode. Only the exit status will go back to the task.\n');
      } else if (line.trim()) {
        return { line, interactive };
      }
      input.prompt();
    }
    return undefined;
  } finally {
    input.close();
  }
}

const shell = process.argv[2];
const file = process.argv[3];
if (!shell || !file) {
  throw new Error('Open this setup terminal from its task.');
}
const report = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW);
try {
  // The parent holds its own file handle. The command never receives a report path or descriptor.
  await unlink(file);
  process.stdout.write(
    'Enter one setup command. Miter shares its exit status and limited output. Type :interactive first for a full-screen installer.\n',
  );
  const command = await readCommand();
  if (!command) {
    process.exitCode = 1;
  } else {
    let args = ['-c', command.line];
    if (command.interactive) {
      args = ['-lc', command.line];
    }
    if (process.platform === 'win32') {
      args = ['-NoLogo', '-Command', command.line];
    }
    let stdio: ['inherit', 'pipe' | 'inherit', 'pipe' | 'inherit'] = ['inherit', 'pipe', 'pipe'];
    if (command.interactive) {
      stdio = ['inherit', 'inherit', 'inherit'];
    }
    let program = shell;
    const pnpm = process.argv[4];
    const plainInstall =
      pnpm && !command.interactive && /^pnpm[ \t]+(?:install|i)$/.test(command.line.trim());
    if (plainInstall) {
      program = pnpm;
      args = ['install'];
    }
    const child = spawn(program, args, { stdio, shell: false });
    let stdout = () => '';
    let stderr = () => '';
    if (child.stdout && child.stderr) {
      stdout = copyOutput(child.stdout, process.stdout);
      stderr = copyOutput(child.stderr, process.stderr);
    }
    let startError = '';
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', (error) => {
        startError = 'The project shell could not start. ' + error.message;
        process.stderr.write(startError + '\n');
        resolve(null);
      });
      child.once('close', resolve);
    });
    await report.writeFile(
      JSON.stringify({
        code,
        stdout: stdout(),
        stderr: startError || stderr(),
        ...(plainInstall && code === 0 && { plainPnpmInstall: true }),
      }),
    );
    if (code !== null) {
      process.stdout.write('\nCommand finished with exit code ' + code + '.\n');
    }
    process.exitCode = code ?? 1;
  }
} finally {
  await report.close();
}
