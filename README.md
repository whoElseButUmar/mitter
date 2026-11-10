# Miter

Chrome extension for running local project tasks through a ChatGPT conversation or an optional local GGUF model. Version: 1.0.0-rc.21.

## Setup

Requires Node.js 22.16 or later and pnpm 12.11.2. Dependencies and the bundled terminal font need internet access.

```sh
node scripts/setup.mjs
```

Setup installs the pinned dependencies, opens pnpm's build approval prompt if needed, builds the app, verifies its assets, and registers the native host. For a first installation, enable Developer mode in `chrome://extensions` and load `apps/extension/.output/chrome-mv3`. For an update, reload the existing extension. Keep the registered project folder in place.

Use `--build-only` to skip registration or `--chromium` to register with Chromium.

## Development

```sh
pnpm check
pnpm build
pnpm dev
```

`pnpm check` runs all source tests, typechecks, formatting, and code/security checks. Use `pnpm format` before checking. See [coding standards](CODING_STANDARDS.md) for the type, schema, and file-splitting conventions.

`pnpm build` regenerates the native host, page bridge, isolated preview sandbox, and unpacked extension. `pnpm register` registers a verified build. `pnpm doctor` checks the built installation without changing project files.

For an offline font build, set `MITER_FONT_FILE` to a licensed `FiraCodeNerdFontMono-Regular.ttf` and `MITER_FONT_LICENSE` to its SIL OFL license text.

## Release verification

After `pnpm check` and `pnpm build`, run the live checks on macOS or Linux:

```sh
pnpm verify:pty
pnpm verify:chrome
pnpm verify:fresh-install
```

- `verify:pty` uses the installed native PTY and a real shell with startup files disabled. It checks input/output, resize, exit, and reset in temporary HOME/project folders.
- `verify:chrome` opens headless Chrome in a temporary profile. It checks the packaged workspace, a real client/background/native-host project round trip, and production dialogs, previews, and fonts with controlled asynchronous responses. It checks task attention layout using only the current packaged workspace stylesheets, with no source-CSS fallback. It also checks focus, validation, visible errors, stale completions, and resource release across 30 mount/dispose cycles. It also checks the packaged preview sandbox's sender identity, malformed messages, exact HTML, isolation, and one-use payload gate. Collected DOM counters are a regression check, not proof that every possible leak is absent.
- `verify:fresh-install` copies the current source, including untracked work, without dependencies, generated output, caches, state, or the lockfile. It runs build-only setup with fresh package-manager caches, reuses only the built licensed font inputs, and verifies the new build. It downloads dependencies and preserves the release-age/build-approval policy; it does not register a host.

The Chrome check defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS. Set `CHROME_PATH` to an absolute executable path elsewhere. Chrome must support the DevTools `Extensions.loadUnpacked` command; the check enables extension debugging only in its temporary process. It refuses to run when a system-wide `ai.mitter.host` registration exists, so it cannot fall back to a launcher pointing at real app data. User registrations are not changed.

Chrome preparation and execution have a two-minute limit. The fresh-install check defaults to eight minutes; use `pnpm verify:fresh-install --timeout-ms=300000` to change it. Owned processes, profiles, checkouts, and state are removed on completion or failure. Chrome logs remain in `.cache/release-checks/chrome.log`; the fresh-install command prints its retained log path.

These checks do not verify an authenticated ChatGPT conversation, OS permission prompts, Windows behavior, or GGUF generation. Test those in the target environment; local generation needs the optional runtime and a configured model file.

## Project

- `apps/extension`: SolidJS + WXT interface, previews, and xterm terminal.
- `apps/host`: native messaging, SQLite state, file operations, approved commands, and PTY sessions.
- `apps/inference`: optional local model process. Install its runtime with `pnpm models:install` and configure your GGUF file in Settings.
- `packages`: shared protocol, chat bridge, UI helpers, and terminal settings.
- `scripts`: build, setup, native registration, and asset verification.

State lives in `~/.mitter` or `MITTER_HOME`. Task edits use file hashes and journals. Commands require approval. Approved commands can affect files outside the project; Stop cannot undo every external effect. ChatGPT tab automation depends on the current browser session and website behavior.

This remains a release candidate. A passing local build does not prove authenticated ChatGPT behavior.

MIT license. See `LICENSE` and `THIRD_PARTY.md`.
