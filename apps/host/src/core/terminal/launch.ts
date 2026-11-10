import os from 'node:os';
import path from 'node:path';
import { promises as fs, constants } from 'node:fs';
import type { Snapshot } from '../../../../../packages/protocol/src/index.js';
import type { PtyOptions } from './pty-adapter.js';

export async function terminalLaunch(
  snapshot: Snapshot,
  projectId: string,
  workerId: string | undefined,
  cols: number,
  rows: number,
): Promise<{
  shell: string;
  args: string[];
  options: PtyOptions;
}> {
  const project = snapshot.projects.find((project) => project.id === projectId);

  if (!project) {
    throw new Error('Open a registered project first.');
  }

  let requested = project.root;

  if (workerId) {
    const worker = snapshot.workers.find(
      (worker) => worker.id === workerId && worker.projectId === projectId,
    );

    if (!worker) {
      throw new Error('The task does not belong to this project.');
    }
    requested = worker.worktree?.root || project.root;
  }

  const cwd = await fs.realpath(requested);

  if (cwd !== requested || !(await fs.stat(cwd)).isDirectory()) {
    throw new Error('The project folder changed. Reopen it before starting a shell.');
  }

  let shell: string;
  let args = ['-l'];

  if (process.platform === 'win32') {
    shell = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    args = ['-NoLogo'];
  } else {
    let fallback = '/bin/bash';

    if (process.platform === 'darwin') {
      fallback = '/bin/zsh';
    }
    shell = os.userInfo().shell || process.env.SHELL || fallback;
  }

  if (!path.isAbsolute(shell) || /[\0\r\n]/.test(shell)) {
    throw new Error('Your login shell path is invalid.');
  }

  await fs.access(shell, constants.X_OK);

  // Normal user environment is intentional only for a human-operated shell.
  // It is never returned over RPC or forwarded to the coding agent.
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Miter';

  return {
    shell,
    args,
    options: {
      name: 'xterm-256color',
      cwd,
      env,
      cols,
      rows,
      encoding: 'utf8',
    },
  };
}
