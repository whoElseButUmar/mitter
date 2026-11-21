import type {
  TerminalOperation,
  TerminalStatus,
} from '../../../../packages/protocol/src/terminal-control.js';
import { verifiedWebResult } from '../../../../packages/bridge/src/presentation.js';

export type TerminalOutput = {
  out: (text: string) => void;
  err: (text: string) => void;
};

export function readable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export function printOperation(operation: TerminalOperation, json: boolean, output: TerminalOutput): void {
  if (json) {
    output.out(JSON.stringify({ type: 'operation', ...operation }));
    return;
  }
  output.out('Request: ' + operation.requestId + ' — ' + operation.state);
  if (operation.workerId) {
    output.out('Task: ' + readable(operation.workerId));
    output.out('Monitor: miter watch ' + readable(operation.workerId));
  }
  if (operation.error) {
    output.err(readable(operation.error));
  }
}

export function printStatus(status: TerminalStatus, json: boolean, output: TerminalOutput): void {
  if (json) {
    output.out(JSON.stringify({ type: 'status', ...status }));
    return;
  }
  const worker = status.worker;
  const result = verifiedWebResult(worker);
  let label = worker.state;
  if (status.progress && !result) {
    label += ' / ' + readable(status.progress.phase);
  }
  output.out(readable(worker.id) + ' — ' + readable(worker.name) + ' — ' + label);
  if (result) {
    output.out('Final verification — ' + readable(result));
    if (status.progress) {
      output.out('Turns ' + status.progress.turns + '/' + status.progress.maxTurns + '.');
    }
  } else if (status.progress) {
    output.out(
      'Turns ' +
        status.progress.turns +
        '/' +
        status.progress.maxTurns +
        '. ' +
        readable(status.progress.reason),
    );
    if (
      status.progress.monitoring === true &&
      status.progress.watchUntil !== undefined &&
      status.progress.watchUntil > Date.now()
    ) {
      output.out('Automatic recovery is still watching for a late reply.');
    }
  }
  if (worker.completion && !result) {
    output.out('Task report before verification — ' + readable(worker.completion.summary));
    output.out('Verification: ' + worker.completion.verification);
    if (worker.completion.evidence) {
      const evidence = worker.completion.evidence;
      output.out(
        'Checks: source ' +
          evidence.source +
          ', domain ' +
          evidence.domain +
          ', browser ' +
          evidence.browser +
          ', Lighthouse ' +
          (evidence.lighthouse ?? 'not recorded') +
          '.',
      );
      output.out(readable(evidence.detail));
    }
  }
  if (worker.error) {
    output.err(readable(worker.error));
  }
}
