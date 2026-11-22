import { hasErrorCode } from './types.js';
import { lineDiff } from '../../../../packages/ui/src/line-diff.js';
import type { FileReview } from '../../../../packages/protocol/src/rpc.js';
export { fileReviewSchema } from '../../../../packages/protocol/src/rpc.js';
export type { FileReview } from '../../../../packages/protocol/src/rpc.js';
import type { Store } from './database.js';
import { fileText, validateRelative } from './workspace.js';
import { imageFileHash } from './workspace/files.js';

export async function reviewFile(
  store: Store,
  runId: string,
  root: string,
  relative: string,
): Promise<FileReview> {
  validateRelative(relative);
  const change = store.fileChange(runId, relative);

  if (!change) {
    throw new Error('No retained file edits for this path in the current run.');
  }

  let currentHash = 'missing';
  let content = '';

  try {
    if (typeof change.after === 'string') {
      content = change.after;
      currentHash = (await fileText(root, relative)).hash;
    } else {
      currentHash = await imageFileHash(root, relative);
    }
  } catch (e) {
    if (!hasErrorCode(e, 'ENOENT')) {
      throw e;
    }
  }

  const conflict = currentHash !== change.afterHash;
  let kind: 'created' | 'modified' = 'modified';

  if (change.before === null) {
    kind = 'created';
  }

  let warning: string | undefined;

  if (conflict) {
    warning = 'The file changed after this recorded edit. Restore is disabled.';
  } else if (typeof change.after !== 'string') {
    warning = 'Image added. There is no text comparison.';
  }

  return {
    path: relative,
    beforeHash: change.beforeHash,
    afterHash: change.afterHash,
    currentHash,
    conflict,
    status: change.status,
    kind,
    diff: lineDiff(change.before ?? '', content),
    canRestore: !conflict && change.status === 'applied',
    warning,
  };
}
