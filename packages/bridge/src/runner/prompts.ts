import type { Worker } from '../../../protocol/src/index.js';
import { unwrapMessage, wrapMessage } from '../message-wire.js';

export function buildReportPrompt(nextPrompt: string, report: string): string {
  return `${nextPrompt}\n\nBEGIN UNTRUSTED MITTER REPORT\n${report}\nEND UNTRUSTED MITTER REPORT\n\nReturn only the next complete mitter/1 JSON object inside one fenced code block labeled json. No commentary outside the block.`;
}

type ExchangeWorker = Pick<Worker, 'id' | 'projectId'>;
function replyContract(exchangeId: string, worker: ExchangeWorker): string {
  return (
    'CURRENT REPLY CONTRACT (this exchange only)\n' +
    JSON.stringify(
      {
        protocol: 'mitter/1',
        id: 'NEW_UNIQUE_REPLY_ID',
        replyTo: exchangeId,
        workerId: worker.id,
        projectId: worker.projectId,
      },
      null,
      2,
    ) +
    '\nThese are required envelope headers, not a complete action batch. Add the required summary string and actions array using the action schema below. Return exactly one fenced json block. Include "replyTo": "' +
    exchangeId +
    '" at the top level. Do not reuse a replyTo from an earlier turn. Use a new unique id. Use ordinary ASCII indentation; do not HTML-encode JSON whitespace or add Markdown backslashes at line endings. The action schema, permissions and checks are unchanged.'
  );
}

function exampleText(worker: ExchangeWorker, exchangeId?: string): string {
  return JSON.stringify(
    {
      protocol: 'mitter/1',
      id: 'REPLACE_WITH_A_NEW_UNIQUE_ID_EVERY_TURN',
      ...(exchangeId && { replyTo: exchangeId }),
      workerId: worker.id,
      projectId: worker.projectId,
      summary: 'What this batch does',
      actions: [{ type: 'list', path: '.' }],
    },
    null,
    2,
  );
}

function replaceTemplateExample(text: string, from: string, to: string): string {
  const reportStart = text.indexOf('BEGIN UNTRUSTED MITTER REPORT');
  if (reportStart < 0) {
    return text.replace(from, to);
  }
  return text.slice(0, reportStart).replace(from, to) + text.slice(reportStart);
}

/** Replace only Mitter's template example. Reports and file content remain literal. */
export function buildExchangeMessage(text: string, exchangeId: string, worker: ExchangeWorker): string {
  const contract = replyContract(exchangeId, worker);
  const linked = replaceTemplateExample(text, exampleText(worker), exampleText(worker, exchangeId));
  return wrapMessage(contract + '\n\n' + linked + '\n\n' + contract, exchangeId);
}

/** Reissue a reviewed message without replacing matching UUIDs in the user's
 * goal, source code or reports. Unrecognized older contracts stay untouched. */
export function renewExchangeMessage(
  text: string,
  previousId: string,
  exchangeId: string,
  worker: ExchangeWorker,
): string | undefined {
  const frame = unwrapMessage(text);
  const oldContract = replyContract(previousId, worker);
  if (
    frame?.exchangeId !== previousId ||
    !frame.payload.startsWith(oldContract + '\n\n') ||
    !frame.payload.endsWith('\n\n' + oldContract)
  ) {
    return;
  }
  const body = frame.payload.slice(oldContract.length + 2, -oldContract.length - 2);
  const originalExample = exampleText(worker, previousId);
  const nextExample = exampleText(worker, exchangeId);
  // The template example has a fixed introduction. Matching that boundary
  // also preserves literal examples quoted in the goal or as a file excerpt.
  const intro =
    'For THIS ChatGPT handoff, wrap the actions in exactly this envelope instead of the simpler local-model shape:\n';
  const reviewed = replaceTemplateExample(body, intro + originalExample, intro + nextExample);
  const contract = replyContract(exchangeId, worker);
  return wrapMessage(contract + '\n\n' + reviewed + '\n\n' + contract, exchangeId);
}

export function buildCorrectionPrompt(
  report: string,
  diagnosis: string,
  attempt: number,
  hasSchemaIssue: boolean,
): string {
  let correctionKind = 'TRANSPORT CORRECTION';
  if (hasSchemaIssue) {
    correctionKind = 'ACTION DATA CORRECTION';
  }
  return `${report}\n\n${correctionKind} ${attempt}/2: Your latest response was not imported. ${diagnosis}\nReturn a new complete mitter/1 envelope inside ONE fenced code block labeled json. No prose outside it. Use ordinary ASCII spaces for JSON indentation, not HTML entities, and actual line breaks, not backslash-newline Markdown. Use a new id and the CURRENT replyTo, not the rejected envelope IDs. Use JSON.stringify-equivalent escaping for all file contents. Preserve JavaScript backticks and backslashes literally inside JSON strings. Do not use inline Markdown. Use smaller batches if needed. Do not repeat already successful actions in the report above. Do not claim the rejected batch executed.`;
}

export function buildTaskLinkCorrection(report: string): string {
  return (
    report +
    '\n\nTASK-LINK CORRECTION: Your immediately previous JSON reply was NOT imported. It omitted replyTo or used an earlier value. Return that unexecuted next step in a NEW envelope using the CURRENT REPLY CONTRACT above and below. Preserve code literally. Do not repeat actions recorded as successful in the report. Do not claim the rejected batch ran.'
  );
}

export function buildMissingResponsePrompt(nextPrompt: string): string {
  return `${nextPrompt}

MISSING RESPONSE RECOVERY
The previous exchange was sent, but no complete response remains readable. Miter did not import any actions for that pending exchange. Earlier accepted batches remain applied. Do not repeat them. Inspect the current project with a small read/list batch before proposing more changes. Use a NEW reply id and this message's CURRENT REPLY CONTRACT. Return one complete fenced json block.`;
}

export function buildReplyRecoveryPrompt(report: string, duplicateSend: boolean): string {
  let diagnosis = 'The previous response could not be read as one complete, literal JSON reply.';
  if (duplicateSend) {
    diagnosis = 'The previous request appears more than once in the chat, so its replies are ambiguous.';
  }
  return `${report}

REPLY RECOVERY
${diagnosis} That exchange is retired. Only this message's CURRENT REPLY CONTRACT can authorize the next batch. Earlier accepted work is recorded in the report above and remains applied. Do not repeat successful actions or reuse earlier reply IDs. Inspect the current project with a small read/list batch before proposing more changes. Return one complete fenced json block with a NEW id and the CURRENT replyTo. Use ordinary ASCII indentation and JSON.stringify-equivalent escaping inside strings; do not HTML-encode whitespace or escape Markdown fences.`;
}
