import { replyPreviewSchema } from '../../../packages/bridge/src/reply-recovery';
import type { ViewRPC } from './ui/rpc';
import { callResult } from './ui/rpc';
import { requireElement } from './ui/dom';
import { onMount, onCleanup } from 'solid-js';
import { mountReplySheet } from '../../../packages/bridge/src/reply-sheet';
import { userReadClipboard } from './client';

export function ReplyRecovery(props: {
  workerId: string;
  rpc: ViewRPC;
  close: () => void;
  applied: () => void;
}) {
  let root: HTMLDivElement | undefined;
  onMount(() => {
    const dispose = mountReplySheet(requireElement(root, 'ReplyRecovery root'), {
      workerId: props.workerId,
      preview: (project) => callResult(props.rpc, replyPreviewSchema, 'bridge.replyPreview', project),
      apply: (project) => props.rpc('bridge.replyApply', project),
      readClipboard: userReadClipboard,
      close: props.close,
      applied: props.applied,
    });
    onCleanup(dispose);
  });

  return (
    <div
      ref={(element) => {
        root = element;
      }}
    />
  );
}
