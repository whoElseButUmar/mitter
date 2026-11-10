# Coding standards

Write code for the person who will read and change it next.

## Files and names

- Keep related behavior together. Split a file when a part has its own responsibility, dependencies, or tests.
- Use names that explain the value or action. Avoid generic context objects and helper layers that only forward calls.
- Keep public entrypoints small. Place substantial implementation in nearby feature folders; share helpers only when callers need the same behavior.
- Use classes for objects that own state, resources, or a lifecycle. Use functions for stateless work, and draft factories for small reactive state. Prefer composition over inheritance; do not build a class hierarchy to share a few callbacks.

## Types and data

- Use `type`, not `interface`. Infer serialized data types from their Zod schemas with `z.infer`.
- Describe schemas and fields in plain English: what the value means, its unit, and any meaningful restriction. Put the root description on the finished schema. Use `.describe(...)` with Zod Classic or `.check(z.describe(...))` with Mini; a field description does not describe the whole record.
- Parse external data where it enters the app: RPC messages, persisted records, configuration, and driver results. A generic return type does not validate a response. Use the shared method registry for RPC parameters and full results; compose feature-owned schemas without importing their owners into the protocol package.
- Validate requests before connecting, admitting work, or performing effects. Validate results before reporting success. Validation must not rewrite exact source, prompts, hashes, or ownership tokens; check the original value and forward it unchanged where those bytes carry authority.
- Use `unknown` until a schema, constructor check, or explicit guard proves the type. Do not use `any`, `z.any()`, casts, non-null assertions, or definite-assignment assertions. Literal `as const` is allowed.
- Make fields optional only when absence is part of the contract. Use a required `T | undefined` field for state that always has a slot but can be cleared. Keep historical data compatible through explicit migration schemas and defaults.
- Keep strict compiler checks enabled, including exact optional properties, unchecked indexed access, unused values, complete return paths, and switch fallthrough.
- Callback, DOM, driver, and resource contracts can use plain types. Do not build schemas for objects that are never serialized.
- Setup and model installation must start before dependencies exist. Their bootstrap reads use dependency-free guards; later reads use Zod.

## Readability

- Use full statements, braced branches and loops, and explicit branches instead of ternaries.
- Separate steps with blank lines. Break long expressions and method chains rather than compressing several operations onto one line.
- Prefer two-space indentation and single quotes. Prettier uses a 110-column target; long literals may remain longer.
- Comments should explain a constraint or decision, not repeat the code.

## Changes and checks

Preserve file confinement, byte-exact source handling, approval checks, reset barriers, and no-replay safeguards. Test both valid inputs and rejected boundary inputs when changing these paths.

Bind drafts, approvals, and async work to the task, project, or dialog that created them. Reserve shared capacity before awaiting browser APIs. Disposal may leave an already-sent mutation running, but its result must not change a replacement owner.

Errors should explain what failed and what the person can do next. Keep validation diagnostics as error causes rather than displaying raw JSON. A lost or malformed acknowledgement does not prove a write failed; check saved state before repeating the action. Retry receipts must match the original request and operation, not only their shape.

Release listeners, timers, and retained payloads on every shutdown path. One failed cleanup step must not prevent the remaining resources from being released. Deduplicate loaded history without silently dropping older records.

```sh
pnpm format
pnpm check
pnpm build
```

`pnpm check` runs source standards, formatting, every source test suite, typechecks, and extension security/boundary checks. Source standards reject unchecked types, `z.any()`, and constructor-declared exported schemas without root descriptions. These syntax checks do not prove every data flow is validated; boundary and ownership tests do that for the cases they cover.

`pnpm build` regenerates and verifies host, extension, page bridge, preview sandbox, and font assets. Neither command replaces a live Chrome, PTY, or model test.

Generated bundles, dependency folders, caches, and `pnpm-lock.yaml` are not maintained as source. Rebuild generated assets rather than editing them.
