import { promises as fs } from 'node:fs';
import { openRuntime } from './runtime.js';
import { errorMessage } from './core/types.js';
import { APP_VERSION } from '../../../packages/protocol/src/index.js';
const argv = process.argv.slice(2);
const portable = argv.includes('--portable');
const args = argv.filter((argument) => argument !== '--portable');
const command = args[0] ?? 'help';

if (command === 'help') {
  console.log(
    `Mitter ${APP_VERSION} — local-first project runner\n\nnode dist/apps/host/src/cli.js [--portable] <command>\n\n  state                         Show local projects and workers\n  request METHOD JSON            Perform one explicit request\n  import WORKER_ID FILE           Import a mitter/1 JSON file\n  run WORKER_ID                   Run its queue / local loop\n  prompt WORKER_ID                Print the conversation bootstrap prompt\n  report WORKER_ID                Print a report for manual sharing\n\n--portable uses Node's built-in SQLite and the reference state graph.\nDefault mode uses better-sqlite3 and XState from pnpm install.\nDo not run this CLI against the same data directory as an active browser host.`,
  );
} else {
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;

  try {
    runtime = await openRuntime({
      portable,
    });
    const service = runtime.service;
    let result: unknown;

    if (command === 'state') {
      result = service.snapshot();
    } else if (command === 'request') {
      if (!args[1]) {
        throw new Error('Provide a method and a JSON object.');
      }
      result = await service.handle(args[1], JSON.parse(args[2] ?? '{}'));
    } else if (command === 'import') {
      result = await service.handle('worker.import', {
        workerId: args[1],
        text: await fs.readFile(args[2] ?? '', 'utf8'),
      });
    } else if (command === 'run') {
      service.run(args[1] ?? '');
      await service.wait(args[1] ?? '');
      result = service.snapshot();
    } else if (command === 'prompt') {
      result = await service.handle('worker.prompt', {
        workerId: args[1],
      });
    } else if (command === 'report') {
      result = await service.handle('worker.report', {
        workerId: args[1],
      });
    } else {
      throw new Error('Unknown command. Run help.');
    }

    if (typeof result === 'string') {
      console.log(result);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  } finally {
    await runtime?.close();
  }
}
