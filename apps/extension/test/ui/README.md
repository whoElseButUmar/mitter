# Extension UI checks

Run from the repository root:

```sh
node apps/extension/test/ui/run.mjs
pnpm --dir apps/extension typecheck
```

The runner uses the installed Rolldown and Solid compiler, with native `node:test`; no additional dependencies are required. Temporary bundles live inside this directory and are removed on success or failure.

- `pnpm check:standards` checks all source and test files for unsafe assertions, unchecked types, ternaries, and unbraced control flow. The UI runner focuses on functional tests; it no longer carries a separate parser or audit.
- `helpers.test.mjs` exercises production schemas, presentation helpers, rewrite permission ordering/cancellation, terminal fallbacks, and the explicit-import build policy.
- `render.test.mjs` compiles production components with Solid's SSR compiler and checks runner branches, semantic controls, dialog naming, and the preexisting terminal appearance copy.
- `lifecycle.test.mjs` uses Solid's browser reactive runtime without a DOM framework. It checks iframe source authentication/listener disposal, animation cancellation, terminal input/polling/disposal, stale file-preview results and Blob URL cleanup, and audio-resource cleanup. Terminal/audio resources are focused test doubles; event dispatch, reactive ownership, Blob URLs, and SHA-256 hashing use native implementations.
- `workspace.test.mjs` exercises the production task-output owner and tab state: file/history generations, task round trips, disconnect/disposal, history pagination/deduplication and failed-page recovery, schema rejection, captured file-list ownership/reset, file-menu arguments, and library/rename targets. Settings and rename forms also have SSR checks for their initial drafts and native labels.
- `ownership.test.mjs` runs the concrete draft factories used by the production forms with Solid's browser reactive runtime. It covers approval-token/run/batch trust, external project navigation and removal, synchronous notification permission ordering, and cancelled/disposed saves completing after a replacement dialog starts. Deferred RPCs prove that sent mutations are not replayed and old owners cannot close, notify, or clear another form's busy state.

SSR checks do not replace a browser interaction test of focus, layout, xterm, or native permission prompts.

The shared `test/browser/task-attention.fixture.tsx` mounts the shipping `TaskView`, runner, follow-up composer, and Console with controlled RPCs and no host or chat connection. `render.test.mjs` checks the full reason, recovery buttons, live announcements, and DOM reading order. The live Chrome dialog check measures every reason line and control at 690/360/320/290px widths, 930/420/360px heights, and with Console open. Its CSS-free release fixture loads only the stylesheets discovered on the packaged workspace, preserving their cascade order, media conditions, and original URLs. Confined-path and loaded-stylesheet checks reject missing assets, symlinks, foreign URLs, extra sheets, and source-CSS fallback before layout runs. Stale packaged CSS must therefore pass the geometry checks itself; fresh source CSS cannot hide it. The default browser fixture and its CSS assertions remain source checks, not packaged-layout verification. The live check verifies that controls remain focusable and hit-testable after scrolling; device emulation and the fixture are released even when an assertion fails.

## RPC coordination

UI RPC functions return `unknown`. Consumed results are parsed by `callResult` using exported protocol/bridge/background schemas or small described UI projections. Ignored mutation results remain `unknown`; no generic assertion is used to make them appear checked. Resume and resend reuse their owning modules' schemas, and rewrite views project the fields common to both local and ChatGPT results. Keep these call sites aligned with the messaging APIs when their public schemas change.
