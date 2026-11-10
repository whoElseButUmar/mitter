# Native host boundaries

The public entrypoints remain `src/runtime.ts`, `src/native.ts`, and `src/cli.ts`.
`src/core/service.ts` keeps the public Service API and explicit request/execution ordering. Its nearby
`service/` owners hold project registration, per-task workflow/run/approval lifecycle, progress records,
command journals, request parsing, and pure report/recovery helpers. See `src/core/service/README.md` for
ownership and safety ordering.

## Inventory and responsibilities

- `adapters/sqlite.ts`: checked `node:sqlite` and `better-sqlite3` resources. Native methods retain their
  receiver; bind parameters, mutation results, and returned rows are validated before use.
- `core/database.ts`, `storage-schemas.ts`: schema-backed application storage. Shared project, worker,
  profile, activity, and lifecycle schemas come from `packages/protocol`; host-only journal and skip
  records have local schemas.
- `core/workspace/files.ts`: path validation, symlink/hardlink refusal, bounded UTF-8 reads, searches,
  and atomic publication. `core/workspace/journal.ts` owns edit planning, recovery, and rollback.
  `core/workspace.ts` preserves its previous public exports.
- `core/terminal.ts`: stateful shell ownership and session lifecycle. `terminal/requests.ts` validates
  strict human-only requests; `launch.ts` selects the canonical cwd and human-shell environment;
  `session-buffer.ts` bounds output and checks acknowledgements; `pty-adapter.ts` checks native
  resources and events. `terminal/helper-check.ts` owns installer-only Mach-O/helper inspection.
  `core/pty-runtime.ts` preserves native-preflight exports and never repairs permissions at startup.
- `core/commands.ts`, `redaction.ts`: reviewed command refusal rules, private agent environment,
  cancellation/process-tree handling, and bounded credential-masked output.
- `core/read-snapshots.ts`, `edit-plan.ts`, `handoff-delivery.ts`: immutable read references, exact
  file-hash preconditions, journal-chain verification, and body-free import acknowledgements.
- `core/host-lock.ts`, `locks.ts`, `state-root.ts`, `reset.ts`, `backups.ts`: inter-process and FIFO
  locks, canonical state identity, durable reset barriers, preserved worktrees, and checksum-verified
  offline state backups.
- `core/collaboration.ts`, `followups.ts`: checked cooperative records and user follow-ups. Source
  selections are compared by their fields, not JSON key order.
- `core/framing.ts`, `request-queue.ts`, `output-queue.ts`: bounded native framing and scheduling.
  `core/health.ts`, `review.ts`, `syntax-check.ts`, `assets.ts`, `worktrees.ts`, `desktop.ts`,
  `model-observations.ts`, `prompts.ts`, and `workflow.ts` retain their focused responsibilities.

## Storage migration

`SqlStatement.get()` returns `unknown`; `all()` returns `unknown[]`. Parse actual row schemas rather
than asserting row types.

`Store.get(key)` returns `unknown`. To obtain a checked typed record, pass its real schema:

```ts
const receipt = store.get(key, handoffDeliverySchema);
```

Schema-backed reads return the schema's inferred output or `undefined` for a missing key. The old
schema-less `get<T>(key)` is intentionally unsupported. Callers that already parse unknown data can
use `get(key)` directly. Invalid stored JSON or incompatible records fail without rewriting them.
The SQLite schema version remains 1; this cleanup requires no database migration or installation.

## Validation

From the repository root, using the existing bridge Rolldown source loader:

```sh
node --import ./packages/bridge/src/runner/test-source-loader.mjs --test apps/host/test/*.test.mjs apps/inference/test/*.test.mjs
node_modules/.bin/tsc -p tsconfig.host.json --noEmit
```

The tests exercise both real SQLite drivers and the real XState graph, plus controlled native
resource/IPC fixtures. They do not run a real model or start a human login shell. The source-standards
regression test excludes the separately owned service files and rejects interfaces, explicit
`any`, casts, assertions, ternaries, unbraced control flow, unchecked custom schemas, and non-NodeNext
relative source imports.
