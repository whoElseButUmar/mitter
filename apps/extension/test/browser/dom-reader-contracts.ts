import { z } from 'zod';

export const DOM_READER_URL = 'https://chatgpt.com/c/reader-fixture';
export const DOM_READER_LATER_USER_TEXT = 'A later human message must remain visible.';

export const domReaderScenarioNameSchema = z
  .enum([
    'mixed-generating',
    'mixed-generating-correlated',
    'complete-roleless',
    'complete-roleless-copy-code',
    'copy-only',
    'later-known-user',
    'different-known-user',
    'receipt-role-conflict',
    'response-role-conflict',
    'response-user-edit',
    'duplicate-receipt',
    'mismatched-receipt',
    'edited-receipt',
    'multiple-unknown-branches',
    'unknown-intervening-branch',
    'unknown-later-branch',
    'scan-limit',
    'iframe-only-receipt',
    'digest-dom-mutation',
    'digest-assistant-progress',
    'digest-duplicate-before-user',
    'digest-earlier-user-receipt',
    'digest-later-known-user',
    'digest-stop',
    'digest-session-replacement',
  ])
  .describe('One offline DOM-reader regression, never a provider conversation.');

export type DomReaderScenarioName = z.infer<typeof domReaderScenarioNameSchema>;

const turnSchema = z
  .strictObject({
    id: z.string().max(100).describe('Stable synthetic message ID, or empty for a non-turn branch.'),
    role: z.enum(['user', 'assistant', 'unknown', 'branch']).describe('Fixture role metadata.'),
    conflict: z.boolean().describe('Add contradictory explicit role metadata to this turn.'),
    text: z.string().max(160000).describe('Synthetic display text kept out of retained observations.'),
    code: z.boolean().describe('Render the text in a highlighted PRE/CODE carrier.'),
    copy: z.boolean().describe('Add a Copy code button without granting response-role evidence.'),
    controls: z.boolean().describe('Add the supported Good response and Bad response buttons.'),
    edit: z.boolean().describe('Add an Edit message button that must block response classification.'),
  })
  .describe('One synthetic real-DOM turn or substantive intervening branch.');

export const domReaderPlanSchema = z
  .strictObject({
    name: domReaderScenarioNameSchema,
    turns: z.array(turnSchema).min(1).max(8).describe('Visible top-frame content in transcript order.'),
    generating: z.boolean().describe('Show the supported composer Stop button instead of Send.'),
    padding: z.number().int().min(0).max(24001).describe('Empty elements used to reach the DOM scan limit.'),
    frameText: z.string().max(160000).describe('An exact receipt decoy in an opaque iframe, or empty.'),
    draft: z.string().max(100).describe('An existing composer draft that read operations must preserve.'),
  })
  .describe('Bounded synthetic DOM input fulfilled entirely offline in a disposable Chrome profile.');

export type DomReaderPlan = z.infer<typeof domReaderPlanSchema>;

const countSchema = z.number().int().nonnegative().max(100000).describe('A bounded structural count.');
const idSchema = z.string().max(200).describe('A synthetic message or task identifier, never message text.');
const receiptStateSchema = z
  .enum([
    'searching',
    'missing',
    'mismatch',
    'ambiguous',
    'collapsed',
    'matched',
    'waiting_reply',
    'unknown_tail',
    'limit',
  ])
  .nullable()
  .describe('Receipt-fallback diagnosis, or null when fallback did not run.');

export const domReaderObservationSchema = z
  .strictObject({
    scenario: domReaderScenarioNameSchema,
    operation: z.enum(['inspect', 'probe']).describe('Read operation exercised through PageTransport.'),
    count: countSchema.describe('Logical turns retained in the page view.'),
    userCount: countSchema.describe('Recognized user turns retained in the page view.'),
    lastRole: z.enum(['', 'user', 'assistant', 'unknown']).describe('Role of the last retained turn.'),
    lastUserId: idSchema.describe('Identity of the latest visible recognized user turn.'),
    userIds: z.array(idSchema).max(256).describe('Retained recognized user IDs in transcript order.'),
    busy: z.boolean().describe('The real supported generation control was detected.'),
    complete: z.boolean().describe('The bridge classified a non-streaming assistant response as complete.'),
    stopped: z.boolean().describe('The owned automation session is stopped.'),
    ready: z.boolean().describe('The real composer was found.'),
    userExact: z.boolean().describe('The view contains the expected full latest user text candidate.'),
    receiptMatched: z.boolean().describe('A complete latest-user candidate matches the saved receipt.'),
    assistantExact: z.boolean().describe('Assistant text equals the synthetic source bytes exactly.'),
    assistantCharacters: countSchema.describe('Assistant text length in UTF-16 code units.'),
    assistantFormat: z.string().max(30).nullable().describe('Source carrier kind, or null when absent.'),
    assistantIssue: z.string().max(100).nullable().describe('Source-carrier diagnosis, or null.'),
    codeReply: z.boolean().describe('The independent code/nonce fast lane returned a candidate.'),
    codeExact: z.boolean().describe('The code candidate preserves the synthetic source bytes exactly.'),
    copyControl: z.boolean().describe('The code fast lane detected a supported Copy code control.'),
    codeIssue: z.string().max(100).nullable().describe('Code fast-lane diagnosis, or null.'),
    receiptState: receiptStateSchema,
    receiptMatches: countSchema.describe('Disjoint full-receipt matches found by the fallback.'),
    responseControls: countSchema.describe('Supported response-only controls on the adjacent branch.'),
    tailBranches: countSchema.describe('Substantive branches after the matched receipt bubble.'),
    unknownTurns: countSchema.describe('Unclassified turn barriers retained after fallback.'),
    unclassifiedTail: z.boolean().describe('Unknown content remains after the latest recognized user.'),
    scanLimited: z.boolean().describe('The composed-tree scan reached a safety limit.'),
    transcriptUsers: countSchema.describe('User count in the transcript diagnostics.'),
    transcriptAssistants: countSchema.describe('Assistant count in the transcript diagnostics.'),
    history: z
      .array(
        z
          .strictObject({
            workerId: idSchema,
            projectId: idSchema,
            count: countSchema.describe('Distinct task bootstrap messages retained in history.'),
          })
          .describe('A task-turn history count without its message bodies.'),
      )
      .max(8)
      .describe('Historical task-turn counts returned by the production reader.'),
  })
  .describe('Concise schema-validated DOM-reader evidence with no message bodies or raw HTML.');

export type DomReaderObservation = z.infer<typeof domReaderObservationSchema>;

export const domReaderReadResultSchema = z
  .discriminatedUnion('ok', [
    z
      .strictObject({ ok: z.literal(true), observation: domReaderObservationSchema })
      .describe('A completed production transport read.'),
    z
      .strictObject({
        ok: z.literal(false),
        code: z.string().min(1).max(100).describe('Validated bridge error code, without page text.'),
      })
      .describe('A fenced or failed read; its result must not be accepted as current.'),
  ])
  .describe('A held inspection result after deterministic DOM mutation or session retirement.');

export const domReaderPageObservationSchema = z
  .strictObject({
    mutations: countSchema.describe('DOM mutations since the synthetic page was mounted.'),
    clicks: countSchema.describe('Button clicks observed on the synthetic provider page.'),
    inputs: countSchema.describe('Composer input events observed on the synthetic page.'),
    draftExact: z.boolean().describe('The pre-existing composer draft remains byte-exact.'),
    automationControls: countSchema.describe('Top-frame Miter Pause hosts currently present.'),
    mainWorldEndpoint: z.boolean().describe('Whether a bridge endpoint leaked into the page main world.'),
    frames: countSchema.describe('Opaque iframe decoys present; their documents are not scanned.'),
    frameOpaque: z.boolean().describe('The main world cannot access the sandboxed decoy document.'),
  })
  .describe('Read-only effects and isolation evidence from the actual Chrome DOM.');

export const domReaderGateSchema = z
  .strictObject({
    calls: countSchema.describe('Real WebCrypto digests held at their completion boundary.'),
    held: z.boolean().describe('The test-only scheduling gate has not yet released those digests.'),
  })
  .describe('Deterministic async scheduling evidence; digest bytes are never mocked.');

export const domReaderControlSchema = z
  .strictObject({
    ready: z.boolean().describe('The selected fixture token still owns a production page session.'),
    stopped: z.boolean().describe('That owned page session has been stopped.'),
  })
  .describe('Read-only session ownership evidence without transcript content.');
