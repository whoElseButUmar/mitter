import { repairFindingText } from '../redaction.js';
import type { BrowserJourney } from './browser-contract.js';

/** Preserve a full example of each distinct failure before applying the model report's limits. */
export function browserRepairFindings(findings: readonly string[], journeys: readonly BrowserJourney[]) {
  const names = ['baseline', ...journeys.map((journey) => journey.name)].sort((a, b) => b.length - a.length);
  const groups = new Map<string, { example: string; message: string; count: number }>();
  for (const finding of findings) {
    const example = repairFindingText(finding);
    let message = example;
    let journey = '';
    const frame = /^(?:desktop|mobile|reflow) \/ (.+)$/s.exec(finding)?.[1];
    if (frame) {
      for (const name of names) {
        if (frame.startsWith(name)) {
          const body = /^(?: \/ (?:initial|step \d+|app tab))?: (.+)$/s.exec(frame.slice(name.length))?.[1];
          if (body) {
            message = repairFindingText(body);
            journey = name;
            break;
          }
        }
      }
    }
    let key = message;
    if (/^Step \d+\b/i.test(message)) {
      // The same failure has different screen coordinates on mobile. Keep differing expected or actual values.
      key = journey + '\n' + message.replace(/\bbounds=-?\d+(?:,-?\d+){3}\b/g, 'bounds');
    }
    const prior = groups.get(key);
    if (prior) {
      prior.count++;
    } else {
      groups.set(key, { example, message, count: 1 });
    }
  }
  const issues = [...groups.values()];
  const details = issues.slice(0, 16).map(({ example, count }) => {
    let prefix = '';
    if (count > 1) {
      prefix = '(' + count + ' occurrences) ';
    }
    return (prefix + example).slice(0, 700);
  });
  if (issues.length <= 1) {
    return { details, summary: details[0] };
  }
  const preview = issues.slice(0, 7);
  const perIssue = Math.floor(450 / preview.length) - 3;
  const snippets = preview.map(({ message }) => {
    // Keep quoted copy and the offending accessibility selector in the short repair line.
    const copy = /^Remove (?:the )?.*?(“[^”]+”)/u.exec(message)?.[1];
    const accessibility = /^Accessibility ([\w-]+): .*? (\[.*\])$/.exec(message);
    let text = message;
    if (copy) {
      text = 'Remove ' + copy;
    } else if (accessibility) {
      text = accessibility[1] + ' ' + accessibility[2];
    }
    if (text.length > perIssue) {
      return text.slice(0, perIssue - 1) + '…';
    }
    return text;
  });
  if (issues.length > preview.length) {
    snippets.push('+' + (issues.length - preview.length) + ' more');
  }
  return { details, summary: snippets.join(' · ') };
}
