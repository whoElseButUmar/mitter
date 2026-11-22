import { z } from 'zod';
import { bootstrapDraftSchema } from '../bootstrap-draft.js';
import {
  readerRevisionSchema,
  receiptDiscoveryStateSchema,
  transcriptDiscoveryStateSchema,
} from '../../../protocol/src/schemas/reader-diagnostic.js';
import { proposalEnvelopeSchema } from '../../../protocol/src/proposal.js';
import { exceedsHandoffBytes } from '../../../protocol/src/reply-json.js';
import { outboundReceiptSchema } from '../message-wire.js';
import { identifierSchema, nonNegativeIntegerSchema } from '../schemas/primitives.js';

export const USER_READER_VERSION = 'user-turn/8';
// Increment when packaged DOM behavior changes without changing the compatible reader protocol.
export const PAGE_READER_REVISION = 9;
// Build verification checks this exact marker in the packaged page script.
export const ASSISTANT_READER_VERSION = 'logical-pre/5-user-turn/8-discovery/8-code-reply/6-send/4-control/2';

export const domRequestSchema = z
  .object({
    op: z
      .enum([
        'control',
        'probe',
        'reply',
        'inspect',
        'prepare',
        'commit',
        'send',
        'clear_draft',
        'stop',
        'interrupt',
      ])
      .describe('Page operation to perform.'),
    token: z.string().max(100).describe('Token identifying the runner that owns this session.'),
    url: z.string().describe('Linked page URL; the root route is allowed while a conversation loads.'),
    workerId: identifierSchema.optional().describe('Worker whose reply is being observed.'),
    projectId: identifierSchema.optional().describe('Project whose reply is being observed.'),
    replyId: identifierSchema.optional().describe('Specific reply to look for.'),
    replyTo: identifierSchema.optional().describe('Pending exchange that the reply must answer.'),
    text: z.string().optional().describe('Outgoing composer text, unchanged by the bridge.'),
    messageId: z.string().optional().describe('Send intent ID used to prevent duplicate clicks.'),
    composerSession: identifierSchema.optional().describe('Document that prepared this send intent.'),
    adoptBootstrapDraft: z
      .literal(true)
      .optional()
      .describe('Prepare and send only if the existing bootstrap draft is still in an empty chat.'),
    staleDraft: bootstrapDraftSchema
      .optional()
      .describe('Exact confirmed stale draft authorized by the coordinator.'),
    receipt: outboundReceiptSchema.optional().describe('Saved receipt for an exact outgoing message.'),
    expiresAt: z.number().describe('Session expiration time in milliseconds since the Unix epoch.'),
    allowConversationBind: z
      .boolean()
      .optional()
      .describe('Allow read-only observation while the route settles.'),
    preservePause: z
      .literal(true)
      .optional()
      .describe('Respect a page pause when reconnecting a saved reply.'),
    includeHistory: z.boolean().optional().describe('Include bounded historical task-turn counts.'),
  })
  .describe('Request sent to the DOM-only page adapter.');
export type DomRequest = z.infer<typeof domRequestSchema>;

/** Diagnostic observations of the newest visible payload, including fragments.
 * These fields never authorize an import or an edit. No source text is logged. */
export const codeReadObservationSchema = z
  .object({
    characters: nonNegativeIntegerSchema.describe('Observed payload length, bounded to the reader limit.'),
    fingerprint: z.string().describe('Short change-detection fingerprint, not an integrity proof.'),
    issue: z.string().describe('Reader diagnosis for this payload.'),
    replyId: identifierSchema.optional().describe('Valid reply ID observed in this payload.'),
    replyTo: identifierSchema.optional().describe('Valid exchange ID observed in this payload.'),
    incomplete: z.boolean().optional().describe('The JSON payload may still be streaming.'),
  })
  .describe('Diagnostic observation of the newest code payload.');
export type CodeReadObservation = z.infer<typeof codeReadObservationSchema>;

/** Structural diagnostics only: never include HTML, message bodies or file paths. */
export const assistantReadStatsSchema = z
  .object({
    extractor: z.literal(ASSISTANT_READER_VERSION).describe('Version of the assistant reader.'),
    preElements: nonNegativeIntegerSchema.describe('PRE elements found in the message.'),
    visiblePreElements: nonNegativeIntegerSchema.describe('PRE elements not hidden by CSS.'),
    nestedWrappers: nonNegativeIntegerSchema.describe(
      'Nested PRE wrappers excluded as duplicate containers.',
    ),
    ignoredHiddenBlocks: nonNegativeIntegerSchema.describe('Hidden PRE elements excluded from reading.'),
    emptyBlocks: nonNegativeIntegerSchema.describe('Empty code payloads found in the message.'),
    logicalBlocks: nonNegativeIntegerSchema.describe('Distinct logical code payloads found.'),
    payloadCharacters: z
      .array(nonNegativeIntegerSchema)
      .describe('Lengths of the first eight code payloads.'),
  })
  .describe('Structural assistant-reader diagnostics without source text.');
export type AssistantReadStats = z.infer<typeof assistantReadStatsSchema>;

export const assistantReadObservationSchema = z
  .object({
    text: z.string().describe('Message text read without repairing source characters.'),
    format: z.enum(['code', 'plain', 'rendered']).describe('How the message text was obtained.'),
    issue: z.string().optional().describe('Reason the observed text is not an acceptable source carrier.'),
    stats: assistantReadStatsSchema.optional().describe('Structural reader diagnostics.'),
  })
  .describe('Serializable portion of an assistant-message read.');
export type AssistantReadObservation = z.infer<typeof assistantReadObservationSchema>;
export type AssistantReadResult = AssistantReadObservation & {
  /** Internal DOM pointer; never included in ChatView or sent to the host. */
  source?: HTMLElement;
};

export const replyRecoverySchema = z
  .object({
    kind: z
      .enum(['unreadable_reply', 'duplicate_send'])
      .describe(
        'A malformed or unclassified response, or repeated exact sent messages requiring a new exchange.',
      ),
    exchangeId: identifierSchema.describe('The saved exchange used to match the complete outgoing message.'),
    userText: z
      .string()
      .max(160000)
      .describe('The complete latest outgoing body matched against its receipt.'),
    responseText: z
      .string()
      .max(400001)
      .refine((text) => !exceedsHandoffBytes(text))
      .describe('Bounded text from one adjacent response carrier; never an import authorization.'),
    format: assistantReadObservationSchema.shape.format,
    issue: z.string().max(100).optional().describe('Why the observed source carrier needs correction.'),
  })
  .describe('Read-only evidence for a bounded fresh-exchange correction, never for importing actions.');
export type ReplyRecovery = z.infer<typeof replyRecoverySchema>;

/** Message discovery is intentionally separate from reading a message's text.
 * A successful script handshake is NOT proof that a transcript was found.
 * Attribute variants are combined per turn, never guessed from code contents
 * or alternating positions. Unknown turn containers remain barriers, so a
 * human message cannot disappear between a confirmed send and a reply.
 */
export type MessageRole = 'user' | 'assistant' | 'unknown' | '';

/** Fallback for a transcript with missing or partial role/test-id metadata.
 * Known users, history and intervening turns remain visible barriers.
 * The user message is discovered by an EXACT saved receipt, never by its text
 * merely looking like a prompt. The following reply must occupy the adjacent
 * content branch and have response-only controls (not just a Copy button).
 * Unknown intervening/later content is a barrier. No whole-page JSON search,
 * alternating-role guess, private app state, or remote endpoint is used.
 */
export const receiptDiscoveryStatsSchema = z
  .object({
    state: receiptDiscoveryStateSchema,
    candidates: nonNegativeIntegerSchema.describe('Potential receipt-containing message bubbles.'),
    matches: nonNegativeIntegerSchema.describe('Disjoint bubbles matching the full saved receipt.'),
    tailBranches: nonNegativeIntegerSchema.describe('Content branches following the verified bubble.'),
    responseControls: nonNegativeIntegerSchema.describe('Response-only controls on the adjacent branch.'),
  })
  .describe('Structural diagnostics for receipt-bound transcript discovery.');
export type ReceiptDiscoveryStats = z.infer<typeof receiptDiscoveryStatsSchema>;

export const codeAncestorSchema = z
  .object({
    tag: z.string().describe('Element tag name, not its text or attribute values.'),
    attributes: z.array(z.string()).describe('Allowed attribute names, never their values.'),
  })
  .describe('Names-only structural observation of a code ancestor.');
export type CodeAncestor = z.infer<typeof codeAncestorSchema>;

export const transcriptStatsSchema = z
  .object({
    version: z.enum(['message-discovery/1', 'message-discovery/2']).describe('Transcript-discovery version.'),
    state: transcriptDiscoveryStateSchema,
    roleAttributes: nonNegativeIntegerSchema.describe('Turns found through the primary role attribute.'),
    alternativeRoles: nonNegativeIntegerSchema.describe('Turns found through alternative role attributes.'),
    semanticRoles: nonNegativeIntegerSchema.describe('Turns found through outer message headings.'),
    turnContainers: nonNegativeIntegerSchema.describe('Visible potential turn containers.'),
    unknownTurns: nonNegativeIntegerSchema.describe('Turn containers whose author is unknown.'),
    unclassifiedTail: z.boolean().describe('Unknown content remains after the latest user turn.'),
    users: nonNegativeIntegerSchema.describe('Discovered user turns.'),
    assistants: nonNegativeIntegerSchema.describe('Discovered assistant turns.'),
    codeBlocks: nonNegativeIntegerSchema.describe('Visible PRE elements outside excluded UI.'),
    openShadowRoots: nonNegativeIntegerSchema.describe('Open shadow roots inspected by the bounded scan.'),
    frames: nonNegativeIntegerSchema.describe('Iframe elements observed without entering their documents.'),
    scanLimited: z.boolean().describe('The composed-tree scan reached a safety limit.'),
    strategy: z.enum(['attributes', 'receipt']).optional().describe('Discovery strategy, when reported.'),
    receiptDiscovery: receiptDiscoveryStatsSchema.optional().describe('Receipt-fallback diagnostics.'),
    // Tag/attribute names only, never class values, IDs, labels or message text.
    codeAncestry: z
      .array(z.array(codeAncestorSchema))
      .optional()
      .describe('Names-only ancestry of up to two code roots.'),
  })
  .describe('Structural transcript diagnostics without message bodies.');
export type TranscriptStats = z.infer<typeof transcriptStatsSchema>;

/** Candidate texts are complete alternative DOM serializations, never repaired
 * source. Only the runner's exact known receipt may select an alternative.
 * No code, names, IDs, or paths are included in these structural statistics. */
export const userReadStatsSchema = z
  .object({
    serializer: z.literal(USER_READER_VERSION).describe('Version of the user-message serializer.'),
    roleElements: nonNegativeIntegerSchema.describe('Role elements inside the user message.'),
    preElements: nonNegativeIntegerSchema.describe('PRE elements inside the user message.'),
    codeElements: nonNegativeIntegerSchema.describe('CODE elements inside the user message.'),
    candidates: nonNegativeIntegerSchema.describe('Complete alternative message serializations.'),
    candidateCharacters: z
      .array(nonNegativeIntegerSchema)
      .describe('Length of each alternative serialization.'),
    framedCandidates: nonNegativeIntegerSchema.describe(
      'Alternatives containing a complete transport frame.',
    ),
  })
  .describe('Structural user-reader diagnostics without message bodies.');
export type UserReadStats = z.infer<typeof userReadStatsSchema>;

export const userReadResultSchema = z
  .object({
    texts: z
      .array(z.string())
      .describe('Complete alternative serializations; only a full receipt may select one.'),
    stats: userReadStatsSchema.describe('Structural user-reader diagnostics.'),
  })
  .describe('Complete user-message serialization candidates.');
export type UserReadResult = z.infer<typeof userReadResultSchema>;

export type MessageDiscovery = {
  messages: HTMLElement[];
  stats: TranscriptStats;
  assistantRead?: AssistantReadResult;
  userRead?: UserReadResult;
  replyRecovery?: ReplyRecovery;
};

/** Independent code-widget lane. Reads the bytes of the code associated with
 * Copy code, NOT the whole transcript or clipboard. This is only a candidate:
 * an exact pending replyTo or explicit UI confirmation is required separately.
 * Schema, deduplication, permissions and hash preconditions remain host gates.
 */
export const codeReplySchema = z
  .object({
    id: z.string().describe('Observed reply ID; authoritative ID validation remains a coordinator gate.'),
    workerId: identifierSchema.describe('Worker named by the observed reply.'),
    projectId: identifierSchema.describe('Project named by the observed reply.'),
    replyTo: z.string().optional().describe('Observed reply correlation value, not a grant of authority.'),
    text: z.string().describe('Original payload text, with source bytes preserved.'),
    hasCopyControl: z.boolean().describe('A nearby supported Copy code control is visible.'),
    format: z.enum(['code', 'plain']).optional().describe('Source carrier, absent for legacy observations.'),
  })
  .describe('Observed task reply that still requires strict coordinator validation.');
export type CodeReply = z.infer<typeof codeReplySchema>;

export const codeReplyScanSchema = z
  .object({
    reply: codeReplySchema
      .optional()
      .describe('Unique candidate satisfying the requested correlation filters.'),
    count: nonNegativeIntegerSchema.describe('Candidate count relevant to the reported result.'),
    issue: z.string().optional().describe('Reason no reply can be selected safely.'),
    unlinked: codeReplySchema
      .optional()
      .describe('Candidate lacking the requested correlation; observation only.'),
    ids: z.array(z.string()).optional().describe('IDs of all observed parseable task replies.'),
    total: nonNegativeIntegerSchema.optional().describe('Total parseable task replies observed.'),
    read: codeReadObservationSchema.optional().describe('Diagnostic observation of the newest payload.'),
  })
  .describe('Result of the independent code-widget scan.');
export type CodeReplyScan = z.infer<typeof codeReplyScanSchema>;

export const taskReplyObservationSchema = codeReplySchema
  .pick({ workerId: true, projectId: true, id: true, replyTo: true })
  .extend({
    protocol: proposalEnvelopeSchema.shape.protocol.describe('Protocol marker used for candidate discovery.'),
    id: codeReplySchema.shape.id
      .optional()
      .catch(undefined)
      .describe('Observed string ID; invalid or absent IDs cannot produce a code candidate.'),
    replyTo: codeReplySchema.shape.replyTo
      .catch(undefined)
      .describe(
        'Observed string correlation, when readable; the original payload still needs strict validation.',
      ),
  })
  .describe('Task-linking fields only, not a proposal validation or execution schema.');
export type TaskReplyObservation = z.infer<typeof taskReplyObservationSchema>;

export const disclosureObservationSchema = z
  .object({
    state: z
      .enum(['none', 'available', 'expanded', 'pending', 'unavailable', 'ambiguous'])
      .describe('Latest user-message disclosure state.'),
    attempts: nonNegativeIntegerSchema.describe('Expansion attempts made for this message.'),
  })
  .describe('Presentation-only user-message expansion observation.');
export type DisclosureObservation = z.infer<typeof disclosureObservationSchema>;
export type MessageDisclosure = { controls: HTMLElement[]; collapsed: boolean };

export const observedTaskTurnSchema = z
  .object({
    workerId: identifierSchema.describe('Worker named in the historical task messages.'),
    projectId: identifierSchema.describe('Project named in the historical task messages.'),
    count: nonNegativeIntegerSchema.describe(
      'Distinct complete task messages observed for this worker and project.',
    ),
  })
  .describe('Bounded historical task-turn count, not an execution receipt.');
export type ObservedTaskTurn = z.infer<typeof observedTaskTurnSchema>;

export const chatViewSchema = z
  .object({
    readerRevision: readerRevisionSchema.optional(),
    url: z.string().describe('Observed page origin and path; root/loading routes are valid observations.'),
    count: nonNegativeIntegerSchema.describe('Discovered transcript turns.'),
    userCount: nonNegativeIntegerSchema.describe('Discovered user turns.'),
    lastRole: z.string().describe('Author role of the latest discovered turn, or an empty string.'),
    assistantId: z.string().describe('Latest assistant identity or a document-local index hint.'),
    assistantText: z.string().describe('Bounded assistant text; not an authorization to execute it.'),
    lastUserText: z.string().describe('Bounded latest user-message serialization.'),
    busy: z.boolean().describe('A visible generation marker or enabled Stop control is present.'),
    complete: z
      .boolean()
      .describe('The latest assistant has nonempty text and no observed generation marker.'),
    draft: z.boolean().describe('The composer contains nonempty draft text.'),
    draftText: z.string().describe('Logical composer text without layout newline substitution.'),
    stopped: z.boolean().describe('This runner has been stopped in the page.'),
    renderedDraftText: z
      .string()
      .optional()
      .describe('Rendered composer echo used only for sent-message reconciliation.'),
    ready: z
      .boolean()
      .optional()
      .describe('The composer or owned control session is available for this operation.'),
    readiness: z.string().optional().describe('Operation-specific readiness diagnosis.'),
    lastUserId: z
      .string()
      .optional()
      .describe('Latest discovered user identity, including document-local hints.'),
    userIds: z.array(z.string()).optional().describe('Bounded discovered user identities.'),
    transcript: transcriptStatsSchema.optional().describe('Structural transcript-discovery diagnostics.'),
    replyRecovery: replyRecoverySchema
      .optional()
      .describe('Receipt-adjacent evidence for correction only, never reply selection or import.'),
    codeReply: codeReplySchema
      .optional()
      .describe('Observed correlated code reply, still subject to coordinator gates.'),
    codeReplyIssue: z.string().optional().describe('Code-reply scan diagnosis.'),
    codeReplyCount: nonNegativeIntegerSchema
      .optional()
      .describe('Candidate count reported by the code-reply scan.'),
    codeRead: codeReadObservationSchema
      .optional()
      .describe('Newest payload diagnostics, including streaming fragments.'),
    interruptOutcome: z
      .enum(['requested', 'idle', 'unavailable'])
      .optional()
      .describe('Result of the exact-document interrupt request.'),
    // Observations only: unlinked code is NEVER promoted into assistantText or imported.
    unlinkedReply: codeReplySchema.optional().describe('Unlinked candidate for transport correction only.'),
    codeReplyIds: z.array(z.string()).optional().describe('Observed task-reply IDs.'),
    codeReplyTotal: nonNegativeIntegerSchema.optional().describe('Total observed task replies.'),
    // Added only by the coordinator after strict validation / explicit approval.
    replyEvidence: z
      .enum(['exchange', 'user'])
      .optional()
      .describe('Coordinator-added reply authorization evidence.'),
    lastUserCollapsed: z
      .boolean()
      .optional()
      .describe('The latest user message has a supported disclosure control.'),
    disclosure: disclosureObservationSchema.optional().describe('Presentation-only expansion status.'),
    lastUserTruncated: z
      .boolean()
      .optional()
      .describe('The latest user text exceeds the bounded transport length.'),
    userReader: z
      .string()
      .optional()
      .describe('User-reader version, absent for operations that do not scan users.'),
    lastUserCandidates: z
      .array(z.string())
      .optional()
      .describe('Complete alternative user-message serializations.'),
    lastUserReadStats: userReadStatsSchema.optional().describe('Structural latest-user reader diagnostics.'),
    observedTaskTurns: z
      .array(observedTaskTurnSchema)
      .optional()
      .describe('Historical counts, present only when requested.'),
    assistantFormat: z
      .enum(['code', 'plain', 'rendered'])
      .optional()
      .describe('Carrier of the latest assistant text.'),
    assistantReadIssue: z.string().optional().describe('Latest assistant-reader diagnosis.'),
    assistantReadStats: assistantReadStatsSchema
      .optional()
      .describe('Structural latest-assistant diagnostics.'),
    // Document-local proof allows a lost commit response to be reconciled, never replayed in a new document.
    composerSession: z
      .string()
      .optional()
      .describe('Document-local preparation identity, absent on read-only probes.'),
    visibility: z
      .enum(['visible', 'hidden', 'prerender'])
      .optional()
      .describe('Document visibility when the view was read.'),
    outcome: z
      .enum(['pending', 'prepared', 'clicked', 'already_clicked', 'already_sent', 'cleared'])
      .optional()
      .describe('Composer transaction outcome, absent for read-only operations.'),
  })
  .describe('Operation-dependent page observations without implicit defaults or execution authority.');
export type ChatView = z.infer<typeof chatViewSchema>;

export function isEmptyChat(view: ChatView): boolean {
  return (
    view.count === 0 &&
    view.userCount === 0 &&
    !view.lastRole &&
    !view.lastUserText &&
    !view.assistantText &&
    !view.codeReply &&
    (!view.transcript || view.transcript.state === 'empty')
  );
}

export const preparedMessageSchema = z
  .object({
    id: z.string().describe('Send intent ID, including legacy document-local IDs.'),
    text: z.string().describe('Exact text prepared in the composer.'),
    renderedText: z.string().optional().describe('Rendered draft echo for manual-send reconciliation.'),
    userCount: nonNegativeIntegerSchema.describe('User-turn count before insertion.'),
    lastUserText: z.string().describe('Latest user text before insertion.'),
    lastUserId: z.string().optional().describe('Latest user identity before insertion.'),
  })
  .describe('Document-local prepared send intent.');
export type PreparedMessage = z.infer<typeof preparedMessageSchema>;

export const committedMessageSchema = z
  .object({
    text: z.string().describe('Exact outgoing text associated with this send intent.'),
    time: z.number().describe('Time recorded before the Send click in milliseconds since the Unix epoch.'),
  })
  .describe('Document-local committed-send ledger entry.');
export type CommittedMessage = z.infer<typeof committedMessageSchema>;
