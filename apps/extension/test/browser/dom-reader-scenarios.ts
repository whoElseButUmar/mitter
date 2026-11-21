import {
  messageDigest,
  outboundReceiptSchema,
  wrapMessage,
  type OutboundReceipt,
} from '../../../../packages/bridge/src/message-wire';
import { domRequestSchema, type DomRequest } from '../../../../packages/bridge/src/chat-dom';
import {
  DOM_READER_URL,
  DOM_READER_LATER_USER_TEXT,
  domReaderPlanSchema,
  domReaderScenarioNameSchema,
  type DomReaderPlan,
  type DomReaderScenarioName,
} from './dom-reader-contracts';

export const READER_WORKER_ID = 'reader_worker';
export const READER_PROJECT_ID = 'reader_project';
export const READER_USER_ID = 'reader-user-current';
export const READER_PRIOR_USER_ID = 'reader-user-prior';
export const READER_LATER_USER_ID = 'reader-user-later';

const exchangeId = '11111111-1111-4111-8111-111111111111';
const priorExchangeId = '22222222-2222-4222-8222-222222222222';
const goal = 'Exercise only synthetic offline reader content.';
const taskPrefix =
  'You are collaborating with Mitter, a local project runner.\n' +
  'GOAL: ' +
  goal +
  '\nFor THIS ChatGPT handoff, preserve exact source.\n' +
  'Task identity: {"workerId":"reader_worker","projectId":"reader_project"}\n';

// Deliberate spaces, CRLF, tabs, escapes, inline markup, and non-BMP text are
// source authority. Compare these bytes before reporting any passing result.
export const READER_REPLY_TEXT =
  ' \r\n{\r\n' +
  '  "protocol": "mitter/1",\r\n' +
  '  "id": "reader_reply",\r\n' +
  '  "workerId": "reader_worker",\r\n' +
  '  "projectId": "reader_project",\r\n' +
  '  "replyTo": "' +
  exchangeId +
  '",\r\n' +
  '  "actions": [],\r\n' +
  '  "note": "  😀 <tag> & \\t \\n \\\"quote\\\" `tick`  "\r\n' +
  '}\r\n\t ';

const literalReply = JSON.stringify(
  {
    protocol: 'mitter/1',
    id: 'reader_reply',
    workerId: READER_WORKER_ID,
    projectId: READER_PROJECT_ID,
    replyTo: exchangeId,
    summary: 'Preserve literal source bytes.',
    actions: [
      {
        type: 'write',
        path: 'literal.js',
        expectedHash: 'missing',
        content: 'const value = `raw &#x20; &nbsp; \\n`;\n// \\"quoted\\" 😀\n',
      },
    ],
  },
  null,
  2,
);

export type DomReaderScenario = {
  name: DomReaderScenarioName;
  plan: DomReaderPlan;
  request: DomRequest;
  receipt: OutboundReceipt;
  expectedUserText: string;
  expectedReplyText: string;
};

function turn(
  id: string,
  role: DomReaderPlan['turns'][number]['role'],
  text: string,
  fields: Partial<DomReaderPlan['turns'][number]> = {},
): DomReaderPlan['turns'][number] {
  return {
    id,
    role,
    conflict: false,
    text,
    code: false,
    copy: false,
    controls: false,
    edit: false,
    ...fields,
  };
}

export async function createDomReaderScenario(rawName: unknown): Promise<DomReaderScenario> {
  const name = domReaderScenarioNameSchema.parse(rawName);
  const payload = taskPrefix + 'Current turn. Keep  two spaces\nand `literal` source.';
  const userText = wrapMessage(payload, exchangeId);
  const priorText = wrapMessage(taskPrefix + 'Prior task turn.', priorExchangeId);
  const priorReply = '{"protocol":"mitter/1","id":"reader_prior_reply","actions":[]}';
  const receipt = outboundReceiptSchema.parse({
    workerId: READER_WORKER_ID,
    projectId: READER_PROJECT_ID,
    goalHash: await messageDigest(goal),
    textHash: await messageDigest(userText),
    renderedHash: await messageDigest(userText),
    payloadHash: await messageDigest(payload),
    acknowledgedHash: await messageDigest(userText),
    acknowledgedUserId: READER_USER_ID,
    exchangeId,
    expectsReplyTo: true,
    messageId: 'reader_send',
    priorReplyIds: ['reader_prior_reply'],
    turn: 2,
    at: Date.now(),
  });
  const priorUser = turn(READER_PRIOR_USER_ID, 'user', priorText);
  const user = turn(READER_USER_ID, 'user', userText);
  const response = turn('reader-response', 'unknown', READER_REPLY_TEXT, { code: true, controls: true });
  const plan: DomReaderPlan = {
    name,
    turns: [
      priorUser,
      turn('reader-assistant-prior', 'assistant', priorReply, { code: true }),
      user,
      response,
    ],
    generating: false,
    padding: 0,
    frameText: '',
    draft: '',
  };
  let expectedUserText = userText;
  let expectedReplyText = READER_REPLY_TEXT;

  switch (name) {
    case 'roleless-code-unanchored-receipt':
    case 'roleless-code-unanchored-duplicate':
    case 'roleless-code-unanchored-human':
    case 'roleless-code-unanchored-unknown':
    case 'roleless-code-unanchored-edited':
    case 'roleless-code-unanchored-quote':
    case 'roleless-code-intervening-branch':
      user.role = 'branch';
      response.role = 'branch';
      response.controls = false;
      plan.turns = [
        turn('reader-old-code', 'branch', '{"note":"Earlier unrelated code"}', { code: true }),
        user,
        response,
      ];
      if (name === 'roleless-code-unanchored-duplicate') {
        plan.turns.splice(1, 0, turn('reader-duplicate-prior', 'branch', userText));
      } else if (name === 'roleless-code-unanchored-human') {
        plan.turns.push(turn(READER_LATER_USER_ID, 'user', DOM_READER_LATER_USER_TEXT));
      } else if (name === 'roleless-code-unanchored-unknown') {
        plan.turns.push(turn('reader-unknown', 'unknown', 'An unclassified real turn.'));
      } else if (name === 'roleless-code-unanchored-edited') {
        user.role = 'user';
      } else if (name === 'roleless-code-intervening-branch') {
        plan.turns.splice(2, 0, turn('reader-unknown', 'branch', 'Intervening substantive content.'));
      }
      break;
    case 'recovery-roleless-literal':
    case 'recovery-roleless-malformed':
    case 'recovery-duplicate-send':
    case 'recovery-duplicate-known':
    case 'recovery-duplicate-known-malformed':
    case 'recovery-duplicate-known-conflicting':
    case 'recovery-duplicate-intervention':
    case 'recovery-duplicate-later-branch':
    case 'recovery-hidden-response':
    case 'recovery-extra-response-text':
      user.role = 'branch';
      response.role = 'branch';
      response.controls = false;
      response.code = false;
      response.text = '```json\n' + literalReply + '\n```';
      if (name === 'recovery-roleless-malformed') {
        response.text = '```json\n' + literalReply.replace('"actions": [', '"actions" [') + '\n```';
      }
      plan.turns = [user, response];
      if (name.startsWith('recovery-duplicate-')) {
        plan.turns.unshift(turn('reader-duplicate-prior', 'branch', userText));
        response.code = true;
        response.text = literalReply;
        receipt.priorUserId = 'receipt-reader_previous_send';
        receipt.priorUserHash = receipt.textHash;
      }
      if (name.startsWith('recovery-duplicate-known')) {
        user.role = 'user';
        response.role = 'assistant';
        const previousUser = plan.turns[0];
        if (previousUser) {
          previousUser.role = 'user';
        }
        if (name === 'recovery-duplicate-known-malformed') {
          response.text = literalReply.replace('"actions": [', '"actions" [');
        }
      }
      expectedReplyText = response.text;
      if (!response.code) {
        // The plain reader emits the markdown DIV's closing block separator
        // outside the fenced JSON; all quoted source bytes remain unchanged.
        expectedReplyText += '\n';
      }
      if (name === 'recovery-duplicate-intervention') {
        plan.turns.push(turn(READER_LATER_USER_ID, 'user', DOM_READER_LATER_USER_TEXT));
      } else if (name === 'recovery-duplicate-later-branch') {
        plan.turns.push(turn('reader-intervening', 'branch', 'A later unknown message.'));
      } else if (name === 'recovery-extra-response-text') {
        response.text += '\nA separate unrelated message after the fenced reply.';
      }
      break;
    case 'literal-fenced-roleless':
    case 'literal-escaped-fence':
    case 'literal-malformed-fence':
      response.code = false;
      response.text = '```json\n' + literalReply + '\n```';
      if (name === 'literal-escaped-fence') {
        response.text = '\\`\\`\\`json\\\n' + literalReply.replaceAll('\n', '\\\n&#x20;') + '\n\\`\\`\\`';
      } else if (name === 'literal-malformed-fence') {
        response.text = '```json\n' + literalReply.replace('"actions": [', '"actions" [') + '\n```';
      }
      expectedReplyText = response.text + '\n';
      break;
    case 'roleless-resend-draft':
    case 'roleless-composer-only':
      user.role = 'branch';
      response.role = 'branch';
      response.text = 'An incomplete response without role metadata.';
      response.code = false;
      response.controls = false;
      plan.turns = [user, response];
      plan.draft = userText;
      if (name === 'roleless-composer-only') {
        user.text = 'An unrelated visible message.';
      }
      break;
    case 'mixed-generating':
    case 'mixed-generating-modern-stop':
    case 'digest-assistant-progress':
      response.text = 'Thinking\nStructuring the outline';
      response.code = false;
      response.controls = false;
      plan.generating = true;
      break;
    case 'mixed-generating-correlated':
      response.copy = true;
      response.controls = false;
      plan.generating = true;
      break;
    case 'complete-roleless-copy-code':
      response.copy = true;
      break;
    case 'copy-only':
      response.copy = true;
      response.controls = false;
      break;
    case 'later-known-user':
      expectedUserText = DOM_READER_LATER_USER_TEXT;
      plan.turns.push(
        turn(READER_LATER_USER_ID, 'user', expectedUserText),
        turn('reader-later-thinking', 'unknown', 'Thinking\nStructuring the outline'),
      );
      plan.generating = true;
      break;
    case 'different-known-user':
      expectedUserText = 'A different known user turn, with no saved receipt.';
      user.id = READER_LATER_USER_ID;
      user.text = expectedUserText;
      break;
    case 'receipt-role-conflict':
      user.conflict = true;
      break;
    case 'response-role-conflict':
      response.conflict = true;
      break;
    case 'response-user-edit':
      response.edit = true;
      break;
    case 'duplicate-receipt':
      plan.turns.splice(3, 0, turn('reader-duplicate', 'unknown', userText));
      receipt.priorUserId = user.id;
      receipt.priorUserHash = receipt.textHash;
      break;
    case 'mismatched-receipt': {
      const wrongHash = await messageDigest('A different complete outbound body.');
      receipt.textHash = wrongHash;
      receipt.renderedHash = wrongHash;
      receipt.acknowledgedHash = wrongHash;
      receipt.payloadHash = wrongHash;
      break;
    }
    case 'edited-receipt':
      user.text = userText.replace('Current turn.', 'Edited turn.');
      expectedUserText = user.text;
      break;
    case 'multiple-unknown-branches':
      plan.turns.splice(3, 0, turn('reader-unknown', 'unknown', 'A substantive unknown turn.'));
      break;
    case 'unknown-intervening-branch':
      plan.turns.splice(3, 0, turn('', 'branch', 'Intervening content without turn metadata.'));
      break;
    case 'unknown-later-branch':
      plan.turns.push(turn('reader-unknown-later', 'unknown', 'A later substantive unknown turn.'));
      break;
    case 'scan-limit':
      plan.padding = 24001;
      break;
    case 'iframe-only-receipt':
      plan.frameText = userText;
      user.text = 'Only an inaccessible iframe contains the saved receipt.';
      expectedUserText = user.text;
      break;
    case 'digest-earlier-user-receipt':
      priorUser.text = wrapMessage(taskPrefix + 'Earlier nonmatching task turn.', exchangeId);
      break;
    case 'digest-later-known-user':
      expectedUserText = DOM_READER_LATER_USER_TEXT;
      break;
    case 'digest-dom-mutation':
    case 'digest-duplicate-before-user':
    case 'digest-stop':
    case 'digest-session-replacement':
    case 'complete-roleless':
      break;
  }

  const request = domRequestSchema.parse({
    op: 'inspect',
    token: 'reader-fixture-' + crypto.randomUUID(),
    url: DOM_READER_URL,
    workerId: READER_WORKER_ID,
    projectId: READER_PROJECT_ID,
    replyTo: exchangeId,
    receipt,
    includeHistory: true,
    expiresAt: Date.now() + 60000,
  });

  return {
    name,
    plan: domReaderPlanSchema.parse(plan),
    request,
    receipt,
    expectedUserText,
    expectedReplyText,
  };
}
