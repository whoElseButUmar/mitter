# Protocol package

Shared protocol data and pure parsing helpers. Runtime sources depend only on this
package and the repository's installed Zod **4.6.5**; they do not import host,
bridge, extension, UI, or terminal modules.

## Public compatibility

The original nine module paths and their exports remain available:

- `src/index.ts`: constants, domain types, helpers, action/check/envelope/RPC parsers.
- `src/proposal.ts`: proposed actions and envelopes, including recorded read bases.
- `src/reply-json.ts`: bounded transport syntax and observation helpers.
- `src/validation.ts`: structured, body-free reply issues and correction advice.
- `src/model-settings.ts`: strict RPC settings and tolerant persisted-settings recovery.
- `src/requests.ts`: source selections and follow-up requests/records/summaries.
- `src/native-transfer.ts`: outgoing native-response framing and ordered inbox.
- `src/rewrite.ts`: draft-only rewrite requests, responses, prompts, and local templates.
- `src/task-brief.ts`: deterministic, display-only task shaping.

`APP_VERSION` identifies the current release and is re-exported through
`index.ts` from `constants.ts`. Views reject a mismatched host and ask for a reload.

Serialized data types are exported `z.infer` aliases from described schemas.
Callbacks, parser callback results, clocks, and live assembly state use ordinary
types. Schema validation is not execution authorization or proof of admission.

**Type-safety boundary:** `NativeMessageInbox.accept(message: unknown): unknown`
replaces its former `any` input/output. Passthrough and reassembled payloads must
be narrowed or validated by the receiving method/event consumer. It intentionally
does not promise an arbitrary caller-selected result type. Its constructor,
framing, limits, messages, and runtime wire behavior are unchanged.

## Internal layout

- `src/rpc.ts` and `src/rpc/`: canonical method parameter/result contracts, shared receipts, files, system, and team data.
- `src/constants.ts`: identities, versions, and core limits.
- `src/helpers.ts`: schema-backed primitive helpers and strict key diagnostics.
- `src/parsing/actions.ts`: executable actions and completion checks.
- `src/parsing/envelopes.ts`: callback-based envelope parsing and RPC requests.
- `src/schemas/primitives.ts`: described text/integer/identifier/object validators.
- `src/schemas/actions.ts`: executable checks/actions and distinct proposed edits.
- `src/schemas/envelopes.ts`: executable/proposed envelopes and RPC carriers.
- `src/schemas/domain.ts`: projects, approvals, workers, activity, and snapshots.
- `src/schemas/requests.ts`: selection/follow-up leaf schemas shared by workers.
- `src/schemas/model-settings.ts`: bounded settings and token/context relationship.
- `src/schemas/issues.ts`: structured reply feedback.
- `src/schemas/native-transfer.ts`: outgoing fragment schema and framing limits.
- `src/schemas/rewrite.ts`: draft rewrite request/response schemas.
- `src/schemas/task-brief.ts`: display-only brief schema.

`Worker` uses the leaf `followupSummarySchema`, not the public request-parser
module. Public facades never feed back into schemas, keeping the complete source
import graph acyclic. The architecture test checks both type and runtime imports.

## Preserved validation rules

- A proposed `base` reference is not an executable `expectedHash`. Only the host
  can resolve the reference into a recorded precondition. Legacy exact hashes
  remain supported; missing or conflicting bases keep their original issue codes.
- Strict unknown-field gates run before field validation where they did before.
  Envelope/action validation order, safe messages, issue fields and zero-based
  action indexes are preserved. `finish` ordering is enforced for proposals only.
- Handoffs are bounded at **400,000 raw UTF-8 bytes**, before trimming/fence removal.
  Text lengths, read offsets, selected ranges, and native fragment character
  counts remain **UTF-16 code units**. Native frames use an **800,000-byte**
  threshold; complete outgoing transfers remain bounded at **32 MiB**.
- Rich-text whitespace normalization runs only outside quoted JSON strings.
  Paths, source code, search text, bases, and hashes are never repaired or trimmed.
  A whole reply may use matching normal or singly escaped triple-backtick fences,
  including a single backslash before a physical linebreak. Prose, multiple blocks,
  mismatched markers, and double escapes remain invalid. `hasCompleteReplyFence`
  identifies the outer transport only; JSON and full envelope validation still apply.
- Defaults exist only at the original boundaries: nullish list paths (`.`),
  nullish pause durations (`120`), nullish request parameters (`{}`), and settings
  RPC/recovery defaults. Follow-up instructions explicitly trim. Incoming `autoStart`
  accepts a boolean or omission, which defaults to `true`; other supplied values are
  rejected with `Invalid autoStart. Use true or false.` Historical persisted flags
  remain compatible. Omitted optional records and fields receive no new defaults.
  Explicitly undefined action optionals are still omitted.
  Persisted model settings reuse the RPC field validators with independent fallback
  values, then repair the token/context relationship; inherited properties stay ignored.
- Native response fragments retain their original tolerance for extra keys; this
  is not an action-input carrier. They remain ordered, bounded, expiry-limited,
  concurrency-limited, and reject nested fragments.
- Rewrite and task-brief strings are draft/display data, never authority to act.

Use the public parsers when legacy error messages/order matter. Direct schema
parsing exposes normal Zod diagnostics; it does not add the parser's structured
`ReplyValidationError` wrapping or transport normalization.

## RPC contracts

`index.ts` and `rpc.ts` export `coreRpcRegistry`, `createRpcRegistry`, `isRpcMethod`,
`parseRpcParams`, `parseRpcResult`, and the inferred `RpcParams`, `RpcResult`, and
`CoreRpcMethod` types. The core registry covers 48 service methods. Bridge progress,
terminal, and reset owners compose their contracts at the transport boundary.
Unknown methods, including inherited object-property names, are rejected.

Validate the original parameters before effects and the complete response before
reporting success. A narrow caller-selected schema does not replace the method's
contract. Validation must preserve literal source, hashes, prompts, and run authority.
Where object identity is part of the local API, validate without replacing the live
object with the parsed copy.

`RpcResultValidationError` has code `RPC_RESULT_INVALID` and is not retryable. A
mutation may have completed before its acknowledgement failed validation. Do not
replay it without reconciling the original operation and durable state.

Revisions, epochs, counters, and timestamps require safe nonnegative integers.
Authority successors must be checked before changing live or persisted state;
invalid authority is rejected rather than clamped or replaced with a default.
Shape validation does not prove authorization, admission, byte/hash equality, or
ownership. Those checks remain in their feature implementations and tests.

## Checks

From the repository root:

```sh
npm --prefix packages/protocol run check
```

Or run the underlying commands directly:

```sh
node_modules/.bin/tsc -p packages/protocol/tsconfig.json
node --import ./packages/bridge/src/runner/test-source-loader.mjs --test packages/protocol/test/*.test.mjs
```

Tests use native `node:test` with the installed Rolldown source loader, not native
TypeScript stripping. They require the repository's installed dependencies and a
Node release supporting the existing loader's `registerHooks` API. No dependencies
or root package scripts were added.

The suite covers parser errors, proposal/executable separation, exact byte and
character boundaries, fragment assembly, default recovery, source selections,
rewrite correlation, deterministic templates, described schemas, import cycles,
and the requested source conventions. `test/public-types.ts` is compile-only
coverage of the original public type shapes and inferred callback result types.

`test/baseline-fingerprint.json` records grouped results from **2,377** cases run
against a temporary copy of the original current-worktree source before editing.
`test/compatibility-cases.mjs` generates the same deterministic mutation corpus.
Outputs include structured errors and omitted-versus-undefined keys; long values
are hashed. The baseline comparison matched all cases before the temporary source
copy was removed. The compatibility tests now explicitly allow nine malformed incoming
`autoStart` cases to fail under the stricter boolean contract; the recorded fingerprint
is unchanged. Fingerprints are regression fixtures, not a mechanism to bless
new behavior by regenerating expectations from the refactored implementation.
