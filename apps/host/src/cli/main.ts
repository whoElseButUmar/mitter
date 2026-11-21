import { APP_VERSION } from '../../../../packages/protocol/src/index.js';
import { createTerminalClient } from '../core/terminal-control/client.js';
import { errorMessage } from '../core/types.js';
import { parseTerminalArguments, terminalHelp } from './arguments.js';
import { runLegacyCommand } from './legacy.js';
import { runTaskCommand } from './tasks.js';
import type { TerminalOutput } from './output.js';

export async function runTerminal(arguments_: readonly string[], output: TerminalOutput): Promise<number> {
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort();
  try {
    const command = parseTerminalArguments(arguments_);
    if (command.command === 'help') {
      output.out('Version ' + APP_VERSION + '\n\n' + terminalHelp);
      return 0;
    }
    if (command.command === 'version') {
      output.out(APP_VERSION);
      return 0;
    }
    if (command.command === 'legacy') {
      return await runLegacyCommand(command, output);
    }
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    return await runTaskCommand(command, {
      client: createTerminalClient({ signal: cancellation.signal }),
      signal: cancellation.signal,
      ...output,
    });
  } catch (error) {
    output.err(errorMessage(error));
    return 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
