# Bridge source

The existing entrypoints remain available so extension and host imports do not need to change.

| Folder           | Responsibility                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `src/dom/`       | Read the chat DOM, discover messages, and prepare or commit composer text.                          |
| `src/runner/`    | Coordinate the task lifecycle, recovery, checkpoints, and reply checks.                             |
| `src/schemas/`   | Shared validation rules and their regression tests.                                                 |
| `src/sheets/`    | Fixed form markup and small DOM lookup helpers. Sheet controllers stay at their public entrypoints. |
| `src/transport/` | Page-message contracts, bounded state validation, transport errors, and tests.                      |
| `src/wire/`      | Message framing, complete-message hashes, and saved send receipts.                                  |
| `src/support/`   | Regression tests for storage, reset, presentation, and source conventions.                          |

Serialized data contracts use described Zod schemas and exported `z.infer` types. Browser objects and injected functions use plain `type` aliases. Optional fields represent missing legacy data or observations that only certain operations produce; schemas do not silently fill them in.

Stateful coordinators remain classes where they own a queue, clock, ledger, or lifecycle. Send and import authorization stays in the runner so cancellation checks and persistence ordering remain visible together.

Native RPC boundaries use the canonical protocol registry, composed with bridge-owned progress schemas through `createRpcRegistry`. `bridgeRpcRegistry` and `requestBridgeRpc` are exported for callers. Requests are inspected without replacing original wire values or host-owned defaults; method-specific results are parsed before lifecycle decisions. Invalid mutation acknowledgements never authorize a blind replay. See `src/runner/README.md` for receipt recovery and the remaining extension/reset feature contracts.

The page script has a dedicated `page-entry.ts`. `scripts/build-page.mjs` bundles its imports into one packaged isolated-world script with Rolldown. No remote code or runtime function serialization is used.

Run the strict typecheck and tests:

```sh
pnpm check:bridge
```

Tests cover task/send recovery, schema validation, sheet disposal, storage barriers, and the real page bundle in a mocked browser context. They do not replace a manual check against a live ChatGPT page.

Support tests are grouped by responsibility in `src/support/*.test.mjs`. Shared data fixtures live in `src/support/fixtures.mjs`; lifecycle harnesses stay with their owning suites. `src/support.test.mjs` retains the native-timeout regression so the existing check script remains valid.

The shared `scripts/source-standards.mjs` guard checks bridge and terminal source and tests for unchecked casts, `any`, interfaces, non-null and definite-assignment assertions, ternaries, and unbraced control flow. Literal `as const` annotations remain allowed. Serialized schemas declared through exported Zod constructors must have descriptions; `z.any()` is not permitted.
