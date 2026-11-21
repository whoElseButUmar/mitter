import { promises as fs } from 'node:fs';
import { errorMessage } from '../core/types.js';
import type { TerminalArguments } from './arguments.js';
import type { TerminalOutput } from './output.js';

export async function runLegacyCommand(
  arguments_: Extract<TerminalArguments, { command: 'legacy' }>,
  output: TerminalOutput,
): Promise<number> {
  const { openRuntime } = await import('../runtime.js');
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;
  try {
    runtime = await openRuntime({ portable: arguments_.portable });
    const service = runtime.service;
    const [first, second] = arguments_.args;
    let result: unknown;
    switch (arguments_.operation) {
      case 'state':
        result = service.snapshot();
        break;
      case 'request':
        result = await service.handle(first ?? '', JSON.parse(second ?? '{}'));
        break;
      case 'import':
        result = await service.handle('worker.import', {
          workerId: first,
          text: await fs.readFile(second ?? '', 'utf8'),
        });
        break;
      case 'run':
        service.run(first ?? '');
        await service.wait(first ?? '');
        result = service.snapshot();
        break;
      case 'prompt':
        result = await service.handle('worker.prompt', { workerId: first });
        break;
      case 'report':
        result = await service.handle('worker.report', { workerId: first });
        break;
    }
    if (typeof result === 'string') {
      output.out(result);
    } else {
      output.out(JSON.stringify(result, null, 2));
    }
    return 0;
  } catch (error) {
    output.err(errorMessage(error));
    output.err(
      'This is an offline maintenance command. Close Miter’s browser connection first, or use miter list, status, and watch with the running host.',
    );
    return 1;
  } finally {
    await runtime?.close();
  }
}
