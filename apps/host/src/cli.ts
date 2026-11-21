import { runTerminal } from './cli/main.js';

process.exitCode = await runTerminal(process.argv.slice(2), {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
});
