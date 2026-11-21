# Service ownership

`../service.ts` keeps the public `Service` API and owns task registration, shared project locks, proposal
admission, task interruption, execution ordering, and host shutdown/reset fencing. Request routing remains
explicit; there is no handler registry, inherited service context, or mixin. Public worker/project maps
retain the same objects used by their owners.

The extracted modules have narrower responsibilities:

- `task-runtime.ts`: one task's workflow, active controller/promise, time budget, durable run cleanup,
  observations/events, queue retirement, and approval lifecycle. Its dependencies are the task, persistence,
  workflow factory, and change notification—not a Service context.
- `project-catalog.ts`: registered project state, confinement/overlap checks, context/name/profile persistence,
  and worktree views whose revisions remain linked to the base project. Service retains the live-task guard
  around profile changes.
- `request-parsing.ts`: pure local-proposal and task-creation parsing, legacy defaults, and transport byte checks.
  A parsed draft validates actions once; summary validation still follows repeated-proposal bookkeeping.
- `state-migration.ts`: pure recovery and legacy completion decisions. The service applies the associated
  persistence, follow-up, and collaboration effects in their original order.
- `reports.ts`: bounded status actions, completion records, and report text.
- `edit-repair.ts`: complete repair audit construction and bounded, whole-JSON observations. Prompt omissions
  do not mutate the full archive or substitute a current hash into a rejected proposal.
- `progress.ts`: bridge progress records, task/goal binding, revision checks, retained counters, and explicit
  budget extensions. Stop owns the transaction that advances the epoch and retires the receipt.
- `command-journal.ts`: durable command intent, result recovery, quarantine, and project revision publication.
  TaskRuntime requests/consumes approval; Service checks grant tokens and project revisions. The journal
  cannot approve a command. Command results remain typed rather than being reparsed in the execution loop.
- `../followups.ts`: shared selection identity, exact live-selection validation, pending capacity, and steering
  admission. Selection equality compares fields, not JSON key order; worker/instruction/status binding remains.
- `schemas.ts`: Zod contracts for service-owned durable records and check/control results. Protocol envelopes,
  profiles, bridge progress, and command results reuse their owning modules' schema exports. Dependency and
  callback contracts remain plain types.

## Ordering that must not change

1. Resolve read references to the immutable recorded read. Never replace them with the live file hash.
2. Publish import acknowledgement in the same transaction as queue admission. Persist start intent before
   scheduling execution. Exact acknowledgement retries never execute an action again.
3. Publish the stop epoch and progress revision before abort callbacks or an awaited stop. Archive the queue
   cursor only after the active run settles. Fresh continuation cannot import an earlier exchange's reply.
4. Preflight a contiguous edit segment before its first write, under one project lock. Publish each edit's
   journal before advancing its cursor. Keep committed files if later execution fails or is stopped.
5. Validate approval tokens, fingerprints, and project revisions. New batches do not inherit command trust.
   Started, interrupted, or malformed command records are quarantined, not replayed. Command verification
   attempts are never treated as fresh checks when their output is cached. A confirmed process-launch
   failure is a finished failed result: it retires the stale plan without claiming unknown side effects.
   Settled command/check failures return handoff tasks to review with bounded evidence. Their remaining
   queues are archived using `retiredQueueSchema` under `miter.retiredQueue.failure.<run>.<batch>` before
   clearing approval trust. This permits a fresh proposal; it never replays the failed action. Missing files
   and false content checks are repair evidence; confinement and unknown I/O errors remain blocking errors.
6. Drain active work and retiring model processes before closing the store or allowing reset to delete state.
   A failed drain stays fenced and can be retried.

The existing database version, record keys (including historical `miter.*` spellings), JSON field names,
worker/run identity, queue IDs, and acknowledgement fingerprints remain unchanged. Valid saved records need
no migration. Malformed command/control acknowledgements now fail explicitly without overwriting evidence
or executing a guessed result.

A consumed batch may drain directly from `queued` to `review` on Resume. Startup also recognizes the exact
legacy `Invalid transition queued → review.` error on paused/blocked handoff tasks whose queue is already
empty. It restores review and records a recovery event without running actions, changing run/progress
identity, or sending a message. Pending approvals, stopped control, unrelated errors, and remaining work
prevent this recovery.

## Validation

Run from the repository root, using installed dependencies only:

```sh
./node_modules/.bin/tsc -p apps/host/src/core/service/tsconfig.json
node --import ./packages/bridge/src/runner/test-source-loader.mjs --test apps/host/src/core/service/*.test.mjs
./node_modules/.bin/tsc -p tsconfig.host.json --noEmit
```

Tests run the real TypeScript sources through the existing bridge Rolldown loader. Service tests enforce
the shared reference workflow graph and use native SQLite in memory and temporary project folders;
approved test commands are local Node scripts. Resume regressions also run the production XState adapter.
Regressions
cover recovery, read binding, admission/start retries, approvals, queue/edit ordering, repair evidence,
command quarantine, failed-command publication before plan retirement, failure review and newly approved
repair batches, fresh verification, consumed legacy batch resume, progress counters,
follow-ups, stop/steer concurrency, shared-lock peers, worktree/base revision linkage, durable run cleanup,
all-task shutdown ordering, and retryable model drains. Source standards also apply to functional test files.

The targeted typecheck includes transitive dependencies. If another owner's database/schema API is midway
through a change, report its errors rather than asserting unknown values into the old types.
