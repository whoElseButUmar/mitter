# Shared UI

Miter’s extension and chat bridge use these DOM controls to edit drafts, browse files and manage workspace tabs.

- `src/forms/` contains the task and follow-up rewrite panel, settings and reset templates, and report schemas. Each composer owns its draft, pending requests and cancellation.
- `src/workspace/` restores saved navigation and applies tab and history actions. `WorkspaceStore` serializes writes and publishes a change only after it is saved.
- `src/preview/` validates file chunks and builds isolated preview documents. It preserves source bytes, including BOM and CRLF, and uses UTF-16 offsets for text selections. Project HTML renders in an opaque sandbox.
- `src/library/` builds searchable project and task rows. `src/native/` handles keyboard navigation, popup positioning and toasts. Each widget manages its own focus and cleanup.

Preview RPCs return `unknown`. The component that consumes a file, change list or health report validates the response before rendering it.

Run `pnpm check:ui` from the repository root for typechecking and DOM fixture tests. Use `pnpm verify:chrome` to exercise rendering and interaction in Chrome.
