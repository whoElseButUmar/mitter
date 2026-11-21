import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalRoot } from './workspace.js';
import { hasErrorCode } from './types.js';

/** A parent location may be the home directory; the new project itself still cannot be. */
export async function canonicalProjectParent(input: string): Promise<string> {
  if (!path.isAbsolute(input)) {
    throw new Error('Choose an existing parent folder, or enter its absolute path.');
  }
  const root = await fs.realpath(input);
  if (!(await fs.stat(root)).isDirectory()) {
    throw new Error('The selected location is not a folder.');
  }
  return root;
}

export async function existingProjectFolder(input: string): Promise<string> {
  try {
    return await canonicalRoot(input);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new Error('That folder does not exist. Choose an existing folder or use Create new.', {
        cause: error,
      });
    }
    if (hasErrorCode(error, 'EACCES') || hasErrorCode(error, 'EPERM')) {
      throw new Error('Miter cannot access that folder. Choose another folder or check its permissions.', {
        cause: error,
      });
    }
    throw error;
  }
}
