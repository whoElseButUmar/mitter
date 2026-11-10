# Shared UI

Framework-independent native DOM controls shared by the extension and bridge. Existing entry modules in
`src/` are public import paths; their selectors, callbacks and text-only rendering are kept stable.

- `workspace/` owns described Zod storage/navigation/action schemas, tolerant migration, reconciliation,
  and the pure reducer. `WorkspaceStore` remains the single serialized durable-write authority.
- `preview/` owns validated asset streaming and bounded isolated document assembly. Original bytes, BOM,
  CRLF and UTF-16 selection offsets are preserved; project HTML goes only to the existing opaque sandbox.
- `forms/` contains static settings/reset templates, shared native rewrite fields, and checked report schemas.
  Shared protocol settings/rewrite/selection contracts remain authoritative.
- `library/` derives searchable rows without changing worker state. `native/` contains shared index navigation
  and typeahead algorithms, popup positioning, toast timing/rendering, and presentation schemas. Widgets own
  their focus and lifecycle rules; `dom/` contains runtime-checked node/element guards.

DOM nodes and executable dependencies use plain type aliases. Data contracts use described Zod schemas and
`z.infer`. Menu/toast presentation schemas deliberately exclude action callbacks. No framework, API, or
runtime dependency has been added.

## Validation

Run from the repository root, using the existing bridge Rolldown source loader:

```sh
pnpm exec tsc -p packages/ui/tsconfig.json
node --import ./packages/bridge/src/runner/test-source-loader.mjs --test packages/ui/test/*.test.mjs
```

Tests cover storage migration, immutable tab/history actions, serialization and failed writes, exact source
bytes, cancellation, file targets, bounded diffs, library filtering, toast timing, and native widget/form
lifecycles, including typeahead, live disabled options, roving focus, and dialog-contained select cleanup.
The small DOM fixture tests controllers, not browser layout or accessibility-tree behavior;
actual top-layer rendering and assistive-technology behavior still need browser testing.

`PreviewRPC` now returns `Promise<unknown>` rather than a caller-selected generic result. `worker.asset`,
`worker.change`, `worker.files`, and `system.health` replies are validated where consumed. Existing callback
implementations remain structurally compatible; consumers must not use `rpc<Result>(...)` to assert a result.
Public function names and import paths are unchanged.
