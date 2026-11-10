import type { Worker } from '../../../protocol/src/index.js';
import { wrapMessage } from '../message-wire.js';

export function buildReportPrompt(nextPrompt: string, report: string): string {
  return `${nextPrompt}\n\nBEGIN UNTRUSTED MITTER REPORT\n${report}\nEND UNTRUSTED MITTER REPORT\n\nReturn only the next complete mitter/1 JSON object inside one fenced code block labeled json. No commentary outside the block.`;
}

/** Replace only Mitter's template example. Reports, user goals and file content
 * remain literal; they must never be rewritten to add an exchange link. */
export function buildExchangeMessage(
  text: string,
  exchangeId: string,
  worker: Pick<Worker, 'id' | 'projectId'>,
): string {
  const contract =
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
    '" at the top level. Do not reuse a replyTo from an earlier turn. Use a new unique id. Use ordinary ASCII indentation; do not HTML-encode JSON whitespace or add Markdown backslashes at line endings. The action schema, permissions and checks are unchanged.';
  const example = {
    protocol: 'mitter/1',
    id: 'REPLACE_WITH_A_NEW_UNIQUE_ID_EVERY_TURN',
    workerId: worker.id,
    projectId: worker.projectId,
    summary: 'What this batch does',
    actions: [{ type: 'list', path: '.' }],
  };
  // Keep replyTo in the same position as the original linked example: saved
  // prepared messages must reconstruct byte-for-byte, including key order.
  const linkedExample = {
    protocol: example.protocol,
    id: example.id,
    replyTo: exchangeId,
    workerId: example.workerId,
    projectId: example.projectId,
    summary: example.summary,
    actions: example.actions,
  };
  const reportStart = text.indexOf('BEGIN UNTRUSTED MITTER REPORT');
  let template = text;
  let report = '';
  if (reportStart >= 0) {
    template = text.slice(0, reportStart);
    report = text.slice(reportStart);
  }
  const linkedTemplate = template.replace(
    JSON.stringify(example, null, 2),
    JSON.stringify(linkedExample, null, 2),
  );
  return wrapMessage(contract + '\n\n' + linkedTemplate + report + '\n\n' + contract, exchangeId);
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
