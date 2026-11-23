# Terminal tasks

With Chrome running Miter, start a task from the source checkout:

```sh
pnpm miter start --project /absolute/path/to/new-app --create --goal-file ./brief.txt --watch
pnpm miter list
pnpm miter status TASK_ID
pnpm miter preview TASK_ID
pnpm miter watch TASK_ID
pnpm miter resume TASK_ID --watch
pnpm miter stop TASK_ID
```

The installer also provides `~/Library/Application Support/Miter/bin/miter`. Source registration provides `~/.mitter/native/miter`. Setup links `~/.local/bin/miter` when that name is free. If `~/.local/bin` is on your PATH, use `miter` directly. Otherwise use the printed command path. Keep Chrome running with Miter enabled. For ChatGPT-backed tasks, sign in to ChatGPT and grant its site permission. After an update, reload Miter once in `chrome://extensions`.

For a managed Mac install, `miter uninstall` removes the local installation. Use `miter uninstall --purge` to delete its saved state too, or add `--dry-run` to review the paths first. See the [uninstall instructions](../../../../scripts/installation/README.md#uninstall).

`--create` permits creating the selected project folder under an existing parent. Without it, the folder must already exist. `--goal` accepts inline text. Goals must contain nonblank text without NUL characters and fit within 4,000 UTF-16 code units. `--goal-file` reads UTF-8 and preserves its text. Starting a ChatGPT task authorizes sending the goal and relevant project files to the site. Skills, styled components, command approvals and browser quality gates follow the same defaults as UI-created tasks.

The command prints a task ID and a durable request ID. Closing `watch` or pressing Ctrl-C stops monitoring only. Reconnect with `miter watch TASK_ID`; use `miter stop TASK_ID` to stop the task. During automatic late-reply recovery, `watch` stays attached while the saved recovery deadline is in the future, Chrome is connected, and the task run is unchanged. Recovery expiry, a run change, or a required approval returns an attention result. Monitoring never extends the recovery deadline or task budget.

If Chrome restarts while Miter is waiting for a confirmed reply, Miter finds the task conversation in the same profile and continues from its saved send receipt. An extension reload can also reconnect to the open chat. An unanswered setup request stays with its task after Chrome restarts. Open that task in the same profile and choose how to run the command. Miter returns the result to its original conversation. For an expired reply watch or an explicit pause, use `miter resume TASK_ID --watch`. Resume retains the remaining turns and time, approvals, and original run boundary. If dispatch is acknowledged but no fresh progress arrives within 30 seconds, the command returns an attention result. Inspect `miter status TASK_ID` before trying again. A plan retired by `miter stop` requires Miter's explicit fresh continuation. Command approvals still require review in Miter. `--request-id UUID` and `--json` are also supported.

`--json` provides structured output. A lost acknowledgement is never silently retried: inspect `miter operation REQUEST_ID` before deciding whether to repeat the operation. Start, resume and stop return a saved receipt; `queued` means the browser has not acknowledged it yet. Inspect it with `miter operation REQUEST_ID`. Exit code 0 means the command was accepted (or a watched task passed verification), 1 means failure, 2 means attention is needed, 3 means Chrome disconnected, and 130 means monitoring was interrupted.

Terminal control uses a private local Unix socket and the existing native host. It does not open another writable database or expose an HTTP control endpoint. The old `state`, `request`, `import`, `run`, `prompt` and `report` maintenance commands still require the browser host to be stopped.

For a completed web app, `miter preview TASK_ID` prints a localhost URL you can open in a browser.
The running host serves the same application and project data as **Run** in the extension.
Use `--json` to read the URL, task run, session ID and idle timeout.

An existing Vite or Next.js project also accepts a local launch prompt through `miter start`. Use the same goal you would enter in the extension, for example `--goal "Install dependencies with pnpm, start the dev server, and open the app preview."`. Miter opens the tab once the app responds. Opening it again reuses the server for the same files. The project terminal provides restart and stop controls.
