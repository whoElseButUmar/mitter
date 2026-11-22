# Release verification

After `pnpm check` and `pnpm build`, run the live checks on macOS or Linux:

```sh
pnpm verify:pty
pnpm verify:chrome
pnpm verify:fresh-install
```

- `verify:pty` uses the installed native PTY and a real shell with startup files disabled. It checks input/output, resize, exit, and reset in temporary HOME/project folders.
- `verify:chrome` opens headless Chrome in temporary profiles. It checks the packaged workspace, a real client/background/native-host project round trip, setup/recovery screens, styled confirmations, and production dialogs, previews, and fonts. In Chrome’s native side panel it runs an app, types a command in a shell, reopens the app session, stops the server, and checks for uncaught exceptions. It checks task attention layout using only the current packaged workspace stylesheets, with no source-CSS fallback. It also checks focus, validation, visible errors, stale completions, and resource release across 30 mount/dispose cycles. Preview checks cover both the packaged file sandbox and the real local static server: modules, CSS, client forms, immutable snapshots, reload persistence and separate origins. Collected DOM counters are a regression check, not proof that every possible leak is absent.
- `verify:fresh-install` copies the current source, including untracked work, without dependencies, generated output, caches, state, or the lockfile. It runs build-only setup with fresh package-manager caches, reuses only the built licensed font inputs, and verifies the new build. It downloads dependencies and preserves the release-age/build-approval policy; it does not register a host.

The Chrome check defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS. Set `CHROME_PATH` to an absolute executable path elsewhere. Chrome must support the DevTools `Extensions.loadUnpacked` command; the check enables extension debugging only in its temporary process. It refuses to run when a system-wide `ai.mitter.host` registration exists, so it cannot fall back to a launcher pointing at real app data. User registrations are not changed.

Chrome preparation and execution have a two-minute limit. The fresh-install check defaults to eight minutes; use `pnpm verify:fresh-install --timeout-ms=300000` to change it. Owned processes, profiles, checkouts, and state are removed on completion or failure. Chrome logs remain in `.cache/release-checks/chrome.log`; the fresh-install command prints its retained log path.

These checks do not verify an authenticated ChatGPT conversation, OS permission prompts, Windows behavior, or GGUF generation. Test those in the target environment; local generation needs the optional runtime and a configured model file.

On macOS, run the full starter trial with `MITER_TEST_STARTER_RELEASE=1 node --import ./packages/bridge/src/runner/test-source-loader.mjs --test apps/host/src/core/service/starter-release.test.mjs`. It creates a temporary project through Miter, checks the production build on desktop and mobile, then saves a note through the managed app and checks it again after Restart in a fresh browser.

After `pnpm build`, run `MITER_TEST_BUILD_RECOVERY=1 node --test scripts/release-checks/chrome-build-recovery.test.mjs` to check the **Reload extension** action. The trial loads the packaged extension into a fresh Chrome profile, changes the fingerprint in a disposable helper copy, and checks that the workspace shows both builds. It then restores the matching helper and verifies that one reload opens a connected workspace. Set `CHROME_PATH` to choose a different Chrome executable.
