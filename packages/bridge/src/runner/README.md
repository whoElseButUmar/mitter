# Bridge runner

The extension uses `BridgeRunner` from `../index.ts` to send task prompts, verify replies and recover interrupted chats.

- `bridge-runner.ts`: guarded asynchronous lifecycle, page/task ownership,
  durable-before-send checkpoints, host import/run ordering and recovery.
- `types.ts`: described Zod status, options, watch, resend-result and legacy-summary
  schemas with inferred types; dependency and callback contracts remain plain types.
- `rpc-results.ts`: the canonical protocol RPC registry composed with bridge-owned
  progress schemas, the native request/result boundary, and compatibility re-exports
  of the shared prompt, seen-receipt and reply-validation schemas. No competing
  prompt, snapshot, admission or mutation-receipt schemas are declared here.
- `progress-load.ts`: canonical and explicitly migrated durable-load schemas.
  Injected load/save adapters return `unknown`; malformed history is rejected without resetting it.
- `chat-identity.ts`: supported routes, message normalization and legacy bootstrap matching.
- `prompts.ts`: literal report/contract/correction construction; never rewrites untrusted reports.
- `reply-validation.ts`: extraction, schema and exchange-nonce validation.
- `progress-recovery.ts`: task-bound legacy migration and canonical registry load validation,
  retaining `PROGRESS_VERSION` and `PROGRESS_BINDING` failures.
- `checkpoint-writer.ts`: serialized saves, sticky save failures and heartbeat comparison.
  Requests and acknowledgements use the composed `worker.bridgeSave` contract.
  Acknowledgements must preserve meaningful checkpoint fields and cannot roll back
  revision or accumulated active time. Queued snapshots and result application
  preserve host revision ordering.
- `reader-diagnostics.ts`: content-free structural, ancestry and full-receipt comparison
  diagnostics; serialization has no send, import or ownership authority.
- `late-reply-watch.ts`: read scheduling, backoff and stable-candidate bookkeeping;
  it has no send, import or execution authority.

The coordinator intentionally retains send/import transitions and their checks
in one place. Helpers do not receive a runner context, and the watch resumes the
ordinary validation path rather than executing a discovered reply itself.

## Canonical native RPC boundaries

`bridgeRpcRegistry` and `requestBridgeRpc` are exported from `../index.ts`.
The registry uses `createRpcRegistry` with `savedTaskProgressSchema` for supported
save migrations, `taskProgressSchema` for saved/extended results, and
`savedBridgeProgressLoadSchema` for durable loads. All core entries retain the
protocol registry's exact schema objects and inferred method result types.

Outgoing parameters are validated before native dispatch, but parsed output is
not sent instead: the host owns normalization and defaults. Original wire fields,
accepted envelope JSON, exact hashes, reviewed task boundaries and execution epochs
are retained. Prompt and report results remain literal strings, including empty
strings, whitespace and source characters.

The runner validates every native prompt, report, snapshot, seen lookup,
reply-validation result, import receipt, start receipt, resume receipt and pause
receipt before consuming it. Task creation validates the canonical full worker
receipt, its usable task ID and its captured project/coding source before reporting
or starting the task. Local task-sheet starts and pauses use the shared run/pause
receipts; handoff start/stop adapters remain extension-owned resource operations.

An invalid mutation acknowledgement means the operation may already have completed.
It stops delivery with `RPC_RESULT_INVALID`; it is not a timeout, does not advance
the unacknowledged delivery stage, and cannot authorize another import, execution
start, correction or chat handoff. Pause failures are reported while the remaining
shutdown barriers still drain. Delayed receipts must still pass the coordinator's
current task/project/epoch and active-owner checks. Cleanup cannot pause a replaced
project or execution epoch, and disposed task sheets cannot close a replacement dialog.

Only `NativeRequestTimeout` for import/run retains bounded exact-delivery recovery.
Retries use the same accepted envelope and hash; the shared recovered import/run
receipt variants acknowledge durable host ownership rather than replaying actions.
Policy, schema and file failures never enter that path. No timeout recovery resends
a prompt or grants a new reply approval.

Injected page adapters return `unknown`. The normal reader, independent Pause
reader, late-watch reader, and rewrite runner apply the bounded page-state schema
before using observations. Page-provided `replyEvidence` is stripped; only the
coordinator can grant it after its unchanged ownership checks. Malformed page commit
acknowledgements remain read-only, even when a document ledger exists.

The runner keeps each stability fingerprint and its start time together. The
unlinked-reply stability window is separate from the overall correction wait:
busy observations reset stability but never renew that wait. A failed or rejected
inspection also resets completed-reply stability before transient recovery. Diagnostic
observations share one per-kind cache; new sends clear only the user-observation entry.

Mixed-role transcripts use the full saved receipt to distinguish an adjacent,
still-generating response from an unsupported layout. Fallback retains recognized
history and message IDs, requires the latest known user to match, and rejects changed
candidate sets or bodies after hashing. Busy alone, Copy code, or an exchange marker
cannot erase unknown/intervening turns. Generation waits remain read-only and within
the task budget. Unclassified content without a full receipt and a single adjacent
response still has a 12-second loading grace. Scan limits remain hard barriers.

ChatGPT can change links and backticks when displaying a sent report. If a
completed, task-linked reply follows that report, the reader can open the
original message’s edit form, read its source, and cancel. Recovery requires a
match against the entire composer text fingerprint saved before sending. The
reader then rechecks the restored turn and reply before normal import. An
existing draft or an ambiguous turn keeps recovery paused.

Literal complete JSON fences, including the observed singly escaped Markdown
fences, retain their original quoted source. Unreadable adjacent responses and
duplicate sends can instead supply `replyRecovery`: a bounded observation that
grants no reply role or import authority. Duplicate sends never select a reply.
After 15 quiet seconds (two minutes for a streaming fragment), the runner verifies
the exact saved receipt, current host ownership and a second live page read. It
then sends the current report with a fresh exchange nonce and asks for a small
inspection batch. Old replies remain unusable for the new exchange. Drafts,
intervening human messages, changed routes and Stop still block the send.

Automatic corrections share the saved two-request allowance per accepted batch
and consume the ordinary turn/time budgets. Resume retains that allowance. An
unreadable provider response cannot cause unlimited sends or replay an accepted
batch; the host's envelope receipts continue to deduplicate local actions.

Local execution uses a fresh validated native snapshot before consulting the chat.
Approval, refusal, queued work and completion are handled there once. Only finished
local work reaches the existing page/draft/ownership checks and durable report-send
path. Prompt loading stays sequential, and explicit reply approval is saved first.

## Remaining feature-owned contracts

The core native registry is complete for the operations above. The following
extension/reset protocols are not core native RPC entries; their owners still need
shared contracts rather than alternate full schemas in bridge.

| Operation                    | Bridge-visible contract and remaining ownership                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Handoff start/stop adapters  | Start consumes `consent: true`, `newChat`, optional `tabId`, `maxTurns`, and `maxMinutes`; retain the owning task/run and one–twenty turn / one–sixty minute initial limits. Extension-owned start/cleanup results are not native `worker.run` receipts.                                                                                         |
| Reply preview/apply adapters | Preview consumes `workerId`, `source: 'chat' \| 'clipboard'`, and optional exact `text`; its existing preview includes a nonempty ticket, matching worker/source, display fields and finite Unix-millisecond expiry. Apply consumes the selected ticket and `confirm: true`; its owner must bind the one-use ticket to the exact task/run/reply. |
| Reset-view port              | Requests are `{ type: 'reset-quiesce', id, identify }` and `{ type: 'reset-identified', id }`; acknowledgements are `{ type: 'reset-ack', id, ok, error? }`. Existing explicit guards consume no self-reported identity. Document proof comes only from independent browser inventory.                                                           |
| Native reset adapters        | Owner-bound callbacks return `{ prepared: boolean }`, `{ cleared: boolean, failures: { path, error }[], preserved: string[] }`, and `{ cleared: boolean }`. These feature-owned results are not in the core registry. Cleanup requires `cleared === true` and no failures; final verification and browser lock removal remain separate barriers. |

Generic native message-envelope handling and cached `snapshot()` production are
outside this package. Their producers must validate at the actual native boundary;
the bridge does not repeatedly reparse cached internal state. DOM pointers, resource
handles, timers, callbacks and internal scheduling values intentionally remain plain types.

## Validation

From the repository root:

```sh
pnpm check:bridge
```

The test-only source loader uses the project's existing Rolldown transformer because
Node's native stripping cannot handle parameter properties in bridge dependencies.
Tests cover exact core-schema reuse, method-specific inferred result types, described
contracts, original wire values, malformed/wrong-variant/stale receipts, durability,
resource disposal and timeout-only recovery. They use mocked page/native boundaries
and do not replace a live Chrome, PTY or model check.
