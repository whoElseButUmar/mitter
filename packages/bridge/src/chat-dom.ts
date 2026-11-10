/** DOM-only adapter with a versioned content-script endpoint. Operations return
 * structured success/error messages; the coordinator never depends on page UI
 * labels as proof that a send happened. See page-transport.ts.
 *
 * Keep this entry point compatible with existing bridge and page callers.
 */
export {
  ASSISTANT_READER_VERSION,
  domRequestSchema,
  codeReadObservationSchema,
  chatViewSchema,
  assistantReadStatsSchema,
  assistantReadObservationSchema,
  transcriptStatsSchema,
  userReadStatsSchema,
  userReadResultSchema,
  receiptDiscoveryStatsSchema,
  codeReplySchema,
  codeReplyScanSchema,
  disclosureObservationSchema,
  observedTaskTurnSchema,
} from './dom/types.js';
export type {
  DomRequest,
  CodeReadObservation,
  ChatView,
  AssistantReadStats,
  AssistantReadResult,
  AssistantReadObservation,
  TranscriptStats,
  UserReadStats,
  ReceiptDiscoveryStats,
  CodeReply,
  CodeReplyScan,
  DisclosureObservation,
  ObservedTaskTurn,
  UserReadResult,
} from './dom/types.js';

export { chatDom, clearChatDomState } from './dom/session-operations.js';
export { getChatDomSession, retireChatDomSession, resetChatDomSessions } from './dom/session-state.js';
export type {
  ChatDomSession,
  ComposerState,
  LegacyChatDomSession,
  MessageReveal,
} from './dom/session-state.js';
export { readAssistantMessage } from './dom/assistant-reader.js';
export {
  editableText,
  messageDisclosure,
  readUserMessageVariants,
  readUserMessage,
} from './dom/user-reader.js';
export {
  messageRole,
  messageIdentity,
  discoverMessages,
  logicalMessages,
} from './dom/transcript-discovery.js';
export { discoverReceiptMessages } from './dom/receipt-discovery.js';
export { readCodeReply } from './dom/code-replies.js';
