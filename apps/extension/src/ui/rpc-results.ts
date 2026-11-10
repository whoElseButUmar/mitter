import type { z } from 'zod';
import { bridgeResendResultSchema as resendResultSchema } from '../../../../packages/bridge/src/runner/types.js';

export { resendResultSchema };
export { resumeResultSchema, continuePendingResultSchema } from '../schemas/local-results.js';
export {
  promptResultSchema as textResultSchema,
  browseResultSchema as fileListSchema,
  folderPickerResultSchema as folderPickSchema,
  historyResultSchema,
  syntaxCheckSchema as syntaxResultSchema,
  type FolderPickerResult as FolderPick,
} from '../../../../packages/protocol/src/rpc.js';

export function resendNotice(result: z.infer<typeof resendResultSchema>): string {
  if (result.replyFound) {
    return 'A reply has arrived. Miter is checking it instead of resending.';
  }
  if (result.pending) {
    return 'Waiting for ChatGPT’s Send button. The saved prompt will send when ready.';
  }
  return 'Pending prompt resent. Watching for its reply.';
}
