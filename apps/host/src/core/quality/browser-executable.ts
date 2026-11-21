import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function browserExecutable(): Promise<string | undefined> {
  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push(path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  } else if (process.platform === 'linux') {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    );
  } else if (process.platform === 'win32') {
    for (const directory of [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ]) {
      if (directory) {
        candidates.push(path.join(directory, 'Google/Chrome/Application/chrome.exe'));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known installation path; never download a browser implicitly.
    }
  }
  return undefined;
}
