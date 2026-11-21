/** Explicit desktop UI operations. Never exposed as model actions. */
import { execFile } from 'node:child_process';
import { z } from 'zod';
import path from 'node:path';
import { canonicalRoot } from './workspace.js';
import { canonicalProjectParent } from './project-folders.js';
import type { FolderPickerResult } from '../../../../packages/protocol/src/rpc.js';
export { folderPickerResultSchema } from '../../../../packages/protocol/src/rpc.js';
import { isRecord, errorMessage, hasErrorCode } from './types.js';

export type DesktopCommand = {
  program: string;
  args: string[];
};

export function folderDialogCommands(
  platform = process.platform,
  purpose: 'project' | 'parent' = 'project',
): DesktopCommand[] {
  let prompt = 'Choose a project folder for Miter';
  if (purpose === 'parent') {
    prompt = 'Choose where to create the new Miter project folder';
  }
  if (platform === 'darwin') {
    return [
      {
        program: '/usr/bin/osascript',
        args: [
          '-e',
          'set selectedFolder to choose folder with prompt "' + prompt + '"',
          '-e',
          'return POSIX path of selectedFolder',
        ],
      },
    ];
  }

  if (platform === 'win32') {
    return [
      {
        program: path.win32.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        args: [
          '-NoProfile',
          '-STA',
          '-Command',
          'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object ' +
            'System.Windows.Forms.FolderBrowserDialog; $d.Description = "' +
            prompt +
            '"; if ($d.ShowDialog() -eq ' +
            '[System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = ' +
            '[System.Text.Encoding]::UTF8; [Console]::Write($d.SelectedPath) }; ' +
            '$d.Dispose()',
        ],
      },
    ];
  }

  return [
    {
      program: 'zenity',
      args: ['--file-selection', '--directory', '--title=' + prompt],
    },
    {
      program: 'kdialog',
      args: ['--getexistingdirectory', process.env.HOME || '/', '--title', prompt],
    },
  ];
}

export function desktopExec(command: DesktopCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command.program,
      command.args,
      {
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 65536,
        windowsHide: true,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(error, {
              stderr,
            }),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

const folderSelectionSchema = z
  .string()
  .describe(
    'Literal UTF-8 folder-picker output; only a Unix transport newline is removed before canonical filesystem checks.',
  );

export async function pickFolder(
  execute: (command: DesktopCommand) => Promise<unknown> = desktopExec,
  platform = process.platform,
  purpose: 'project' | 'parent' = 'project',
): Promise<FolderPickerResult> {
  for (const command of folderDialogCommands(platform, purpose)) {
    try {
      const parsed = folderSelectionSchema.safeParse(await execute(command));

      if (!parsed.success) {
        throw new Error('The folder picker returned an invalid selection.', { cause: parsed.error });
      }

      if (!parsed.data.trim()) {
        return {
          cancelled: true,
        };
      }

      // Native Unix choosers append one output newline; spaces can belong to the folder name.
      let selected = parsed.data;
      if (platform !== 'win32') {
        selected = selected.replace(/\r?\n$/, '');
      }

      let root;
      if (purpose === 'parent') {
        root = await canonicalProjectParent(selected);
      } else {
        root = await canonicalRoot(selected);
      }
      return { root, cancelled: false };
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        continue;
      }

      let stderr = '';
      let code: unknown;
      let killed = false;

      if (isRecord(error)) {
        if (typeof error.stderr === 'string') {
          stderr = error.stderr;
        }
        code = error.code;
        killed = error.killed === true;
      }

      if (
        /\(-128\)|user canceled|user cancelled/i.test(stderr) ||
        (platform !== 'darwin' && (code === 1 || code === '1'))
      ) {
        return {
          cancelled: true,
        };
      }

      if (killed) {
        throw new Error('Folder picker timed out. Choose again or enter the path manually.');
      }

      throw new Error(
        'Could not open the folder picker. You can enter the path manually. ' +
          (stderr || errorMessage(error)).slice(0, 400),
        { cause: error },
      );
    }
  }

  throw new Error(
    'No folder picker is installed. On Linux use zenity or kdialog, or ' + 'enter the path manually.',
  );
}

export async function revealProject(root: string): Promise<void> {
  const canonical = await canonicalRoot(root);

  if (canonical !== root) {
    throw new Error('Project root changed. Re-register it.');
  }

  let command: DesktopCommand = {
    program: 'xdg-open',
    args: [root],
  };

  if (process.platform === 'darwin') {
    command = {
      program: '/usr/bin/open',
      args: [root],
    };
  } else if (process.platform === 'win32') {
    command = {
      program: path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'),
      args: [root],
    };
  }

  await desktopExec(command);
}
