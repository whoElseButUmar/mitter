import { ASSISTANT_READER_VERSION, type ChatView } from '../chat-dom.js';
import { messageDigest, unwrapMessage, type OutboundReceipt } from '../message-wire.js';

function boundedCount(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return 0;
  }
  return Math.min(value, maximum);
}

/** Structural diagnostics deliberately omit message and file contents. */
export function assistantReadShape(view: ChatView): string | undefined {
  const stats = view.assistantReadStats;
  if (!stats) {
    return;
  }
  const count = (value: unknown): number => boundedCount(value, 10000000);
  let lengths: number[] = [];
  if (Array.isArray(stats.payloadCharacters)) {
    const payloadSizes = stats.payloadCharacters.slice(0, 8);
    lengths = payloadSizes.map(count);
  }
  const knownIssues = [
    'MULTIPLE_BLOCKS',
    'EXTRA_CONTENT',
    'MARKDOWN_TRANSFORMED',
    'CODE_NOT_VISIBLE',
    'EMPTY_CODE_BLOCK',
    'PLAIN_STRING_LAYOUT',
    'PLAIN_HIDDEN_CONTENT',
    'PAYLOAD_TOO_LARGE',
  ];
  let issue = 'none';
  if (view.assistantReadIssue && knownIssues.includes(view.assistantReadIssue)) {
    issue = view.assistantReadIssue;
  }
  return `reader=${ASSISTANT_READER_VERSION}; pre=${count(stats.preElements)}; visible=${count(stats.visiblePreElements)}; wrappers=${count(stats.nestedWrappers)}; hidden=${count(stats.ignoredHiddenBlocks)}; empty=${count(stats.emptyBlocks)}; payloads=${count(stats.logicalBlocks)}; sizes=${lengths.join(',')}; issue=${issue}.`;
}

export function transcriptReadShape(transcript: NonNullable<ChatView['transcript']>): string {
  const count = (value: number): number => boundedCount(value, 24000);
  const shape = `state=${transcript.state}; roles=${count(transcript.roleAttributes)}; alternatives=${count(transcript.alternativeRoles)}; headings=${count(transcript.semanticRoles)}; turns=${count(transcript.turnContainers)}; users=${count(transcript.users)}; assistants=${count(transcript.assistants)}; unknown=${count(transcript.unknownTurns)}; code=${count(transcript.codeBlocks)}; shadows=${count(transcript.openShadowRoots)}; frames=${count(transcript.frames)}; limited=${!!transcript.scanLimited}.`;
  const receipt = transcript.receiptDiscovery;
  let receiptShape = '';
  if (receipt) {
    receiptShape = ` receipt=${receipt.state}; candidates=${count(receipt.candidates)}; matches=${count(receipt.matches)}; tail=${count(receipt.tailBranches)}; controls=${count(receipt.responseControls)}.`;
  }
  return shape + receiptShape;
}

export function userReadStructure(
  stats: ChatView['lastUserReadStats'],
): { roles: number; pres: number; codes: number; frames: number } | undefined {
  if (!stats) {
    return undefined;
  }
  return {
    roles: stats.roleElements,
    pres: stats.preElements,
    codes: stats.codeElements,
    frames: stats.framedCandidates,
  };
}

export function userReadShape(
  view: ChatView,
  acknowledged: boolean,
  exact: boolean,
  prior: boolean,
  duplicate: boolean,
  expectedCharacters: number,
): string {
  const readers = ['user-turn/6', 'user-turn/5', 'user-turn/4', 'user-turn/3', 'user-turn/2'];
  let reader = 'legacy';
  if (view.userReader && readers.includes(view.userReader)) {
    reader = view.userReader;
  }
  const visible = !!view.lastUserText || !!view.lastUserId;
  return `ack=${acknowledged}; match=${exact}; visible=${visible}; prior=${prior}; duplicate=${duplicate}; truncated=${!!view.lastUserTruncated}; observedChars=${view.lastUserText.length}; expectedChars=${expectedCharacters}; ids=${(view.userIds || []).length}; reader=${reader}.`;
}

export function codeReplyReadShape(view: ChatView, pendingExchange: boolean): string {
  return JSON.stringify({
    pendingExchange,
    issue: view.codeReplyIssue || 'none',
    total: view.codeReplyTotal ?? 0,
    matches: view.codeReplyCount ?? 0,
    busy: view.busy,
    draft: view.draft,
    selected: !!view.replyEvidence,
    unlinked: !!view.unlinkedReply,
  });
}

export function transcriptAncestryShape(transcript: NonNullable<ChatView['transcript']>): string | undefined {
  if (!transcript.codeAncestry?.length) {
    return;
  }
  return JSON.stringify({
    strategy: transcript.strategy,
    codeAncestry: transcript.codeAncestry.map((chain) =>
      chain.map((node) => ({ tag: node.tag, attributes: node.attributes })),
    ),
  });
}

export async function userReceiptComparison(
  view: ChatView,
  receipt: OutboundReceipt | undefined,
  restoring: boolean,
  stage: string,
): Promise<string> {
  const frame = unwrapMessage(view.lastUserText);
  const observed = await messageDigest(view.lastUserText);
  return JSON.stringify({
    restoring,
    stage,
    receiptAvailable: !!receipt,
    observedMatchesText: receipt?.textHash === observed,
    observedMatchesRendered: receipt?.renderedHash === observed,
    observedMatchesAcknowledged: receipt?.acknowledgedHash === observed,
    framed: !!frame,
    sameExchange: !!frame && frame.exchangeId === receipt?.exchangeId,
    payloadMatches:
      !!frame && !!receipt?.payloadHash && (await messageDigest(frame.payload)) === receipt.payloadHash,
    candidates: view.lastUserCandidates?.length || 0,
    structure: userReadStructure(view.lastUserReadStats),
  });
}
