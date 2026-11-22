/** Explicit desktop UI operations. Never exposed as model actions. */
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import path from 'node:path';
import { canonicalRoot } from './workspace.js';
import { canonicalProjectParent } from './project-folders.js';
import type { FolderPickerResult, ModelPickerResult } from '../../../../packages/protocol/src/rpc.js';
export { folderPickerResultSchema } from '../../../../packages/protocol/src/rpc.js';
import { isRecord, errorMessage, hasErrorCode } from './types.js';

export type DesktopCommand = {
  program: string;
  args: string[];
};

type PickerPurpose = 'project' | 'parent' | 'model';

function dialogCommands(platform: NodeJS.Platform, purpose: PickerPurpose): DesktopCommand[] {
  let prompt = 'Choose a project folder for Miter';
  if (purpose === 'parent') {
    prompt = 'Choose where to create the new Miter project folder';
  } else if (purpose === 'model') {
    prompt = 'Choose a local .gguf model for Miter';
  }

  if (platform === 'darwin') {
    let choose = 'choose folder';
    if (purpose === 'model') {
      choose = 'choose file of type {"gguf"}';
    }

    return [
      {
        program: '/usr/bin/osascript',
        args: [
          '-e',
          'set selectedItem to ' + choose + ' with prompt "' + prompt + '"',
          '-e',
          'return POSIX path of selectedItem',
        ],
      },
    ];
  }

  if (platform === 'win32') {
    let dialog = 'FolderBrowserDialog; $d.Description = "' + prompt + '"; ';
    let selection = '$d.SelectedPath';
    if (purpose === 'model') {
      dialog = 'OpenFileDialog; $d.Title = "' + prompt + '"; $d.Filter = "GGUF models (*.gguf)|*.gguf"; ';
      selection = '$d.FileName';
    }

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
            'System.Windows.Forms.' +
            dialog +
            'if ($d.ShowDialog() -eq ' +
            '[System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = ' +
            '[System.Text.Encoding]::UTF8; [Console]::Write(' +
            selection +
            ') }; ' +
            '$d.Dispose()',
        ],
      },
    ];
  }

  const start = process.env.HOME || '/';
  if (purpose === 'model') {
    return [
      {
        program: 'zenity',
        args: ['--file-selection', '--file-filter=GGUF models | *.[gG][gG][uU][fF]', '--title=' + prompt],
      },
      {
        program: 'kdialog',
        args: ['--getopenfilename', start, '*.[gG][gG][uU][fF]|GGUF models', '--title', prompt],
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
      args: ['--getexistingdirectory', start, '--title', prompt],
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

const desktopSelectionSchema = z
  .string()
  .describe(
    'Literal UTF-8 picker output; only a Unix transport newline is removed before filesystem checks.',
  );

async function choosePath(
  execute: (command: DesktopCommand) => Promise<unknown>,
  platform: NodeJS.Platform,
  purpose: PickerPurpose,
): Promise<string | undefined> {
  let picker = 'folder picker';
  if (purpose === 'model') {
    picker = 'file picker';
  }

  for (const command of dialogCommands(platform, purpose)) {
    try {
      const parsed = desktopSelectionSchema.safeParse(await execute(command));

      if (!parsed.success) {
        throw new Error('The ' + picker + ' returned an invalid selection.', { cause: parsed.error });
      }

      if (!parsed.data.trim()) {
        return undefined;
      }

      // Native Unix choosers append one output newline; spaces can belong to the folder name.
      let selected = parsed.data;
      if (platform !== 'win32') {
        selected = selected.replace(/\r?\n$/, '');
      }

      return selected;
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
        (platform !== 'darwin' && !killed && (code === 1 || code === '1'))
      ) {
        return undefined;
      }

      if (killed) {
        throw new Error('The ' + picker + ' timed out. Choose again.');
      }

      throw new Error('Could not open the ' + picker + '. ' + (stderr || errorMessage(error)).slice(0, 400), {
        cause: error,
      });
    }
  }

  throw new Error('No ' + picker + ' is installed. On Linux, install zenity or kdialog and try again.');
}

export async function pickFolder(
  execute: (command: DesktopCommand) => Promise<unknown> = desktopExec,
  platform = process.platform,
  purpose: 'project' | 'parent' = 'project',
): Promise<FolderPickerResult> {
  const selection = await choosePath(execute, platform, purpose);
  if (selection === undefined) {
    return { cancelled: true };
  }

  let root;
  if (purpose === 'parent') {
    root = await canonicalProjectParent(selection);
  } else {
    root = await canonicalRoot(selection);
  }
  return { root, cancelled: false };
}

export async function checkModelFile(file: string): Promise<void> {
  if (!path.isAbsolute(file) || !file.toLowerCase().endsWith('.gguf')) {
    throw new Error('Choose a local .gguf model file.');
  }

  const info = await stat(file).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new Error('This model file is unavailable. Choose it again.', { cause: error });
    }
    throw error;
  });
  if (!info.isFile()) {
    throw new Error('Choose a .gguf file. The selected path is not a file.');
  }
}

export async function pickModelFile(
  execute: (command: DesktopCommand) => Promise<unknown> = desktopExec,
  platform = process.platform,
): Promise<ModelPickerResult> {
  const selection = await choosePath(execute, platform, 'model');
  if (selection === undefined) {
    return { cancelled: true };
  }

  await checkModelFile(selection);
  return { path: selection, cancelled: false };
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
