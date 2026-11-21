# Native host

Chrome starts [native.ts](src/native.ts) through native messaging. The [runtime](src/runtime.ts) opens SQLite,
constructs the service and owns the host lease. [Service](src/core/service.ts) orders requests, approvals,
edits, commands and completion checks. The [service guide](src/core/service/README.md) describes the
ordering required when a task stops, resumes or retries a request.

## Where to make a change

| Area                                                     | Code                                                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Project registration, task state, approvals and progress | [service](src/core/service/)                                                                                                  |
| File confinement, atomic writes and rollback             | [workspace](src/core/workspace/), [edit plans](src/core/edit-plan.ts)                                                         |
| Human-operated shell sessions                            | [terminal](src/core/terminal.ts) and its [PTY adapter and output buffer](src/core/terminal/)                                  |
| Agent commands, process cleanup and output redaction     | [commands](src/core/commands.ts), [command journal](src/core/service/command-journal.ts), [redaction](src/core/redaction.ts)  |
| Previewing and checking generated apps                   | [preview](src/core/preview/README.md), [automatic verification](src/core/quality/README.md)                                   |
| Database reads, journals and offline backups             | [store](src/core/database.ts), [record schemas](src/core/storage-schemas.ts), [backups](src/core/backups.ts)                  |
| Chrome message framing and scheduling                    | [framing](src/core/framing.ts), [incoming requests](src/core/request-queue.ts), [outgoing messages](src/core/output-queue.ts) |

## Terminal task control

The [CLI](src/cli/) connects to the active host through a private Unix socket.
[Terminal control](src/core/terminal-control/) authenticates the caller and saves a receipt for each request.
The host opens the socket while it owns the runtime lease and drains it before reset or shutdown.

A connected extension claims pending requests through the native port. The host saves each claim before
delivery. Retrying an identical request ID returns the original receipt. Reusing the ID with different
arguments fails. After an interruption, use the receipt to inspect what happened.

A successful dispatch means Chrome acknowledged the request. Follow the task with `miter watch` for
its verification result. Closing the watcher leaves the task running. See [terminal commands](src/cli/README.md).

## Commands and verification

Chrome may start Miter without a login shell. A registered `node` command uses the host's Node executable.
Miter puts its directory first on the command's PATH so child processes can find it. An explicit executable
path selects the reviewed program. Commands receive a restricted environment.

If a process cannot start, the host records setup guidance. A corrected command needs a fresh request and
approval. If a process started and its outcome is unknown, the command journal quarantines that attempt.
On a known command or completion-check failure, handoff tasks retain the results and completed changes,
archive the remaining queue and request a repair within the task's turn and time limits.

For changed web apps, the host also checks the declared journeys on an immutable snapshot. These checks
cover source, isolated domain tests, desktop and mobile browser behavior, accessibility rules and Lighthouse.
The domain runner requires macOS and Node 26 or later. The browser runner requires installed Chrome.
See [verification and its limits](src/core/quality/README.md).

## Reading stored data

SQLite rows and `store.get(key)` return unchecked data. Pass the record schema to load a typed value:

```ts
const receipt = store.get(key, handoffDeliverySchema);
```

A missing key returns `undefined`. An incompatible record raises an error and retains the original data.

## Tests

Run `pnpm check:host` from the repository root for host type checks, SQLite and workflow tests, local
inference fixtures, CLI and native messaging tests, and the app verification suite. Run `pnpm verify:pty`
for the installed native terminal.
