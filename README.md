# Miter

Chrome extension for running local project tasks through a ChatGPT conversation or an optional local GGUF model. Version: 1.0.0-rc.21.

## Setup

Requires Node.js 22.16 or later and pnpm 10.11.0. Dependencies and the bundled terminal font need internet access.

```sh
node scripts/setup.mjs
```

Setup installs the locked dependencies, opens pnpm's build approval prompt if needed, builds the app, verifies its assets, and registers the native host. For a first installation, enable Developer mode in `chrome://extensions` and load `apps/extension/.output/chrome-mv3`. For an update, reload the existing extension. Keep the registered project folder in place.

Use `--build-only` to skip registration or `--chromium` to register with Chromium.

## Development

```sh
pnpm check
pnpm build
pnpm dev
```

`pnpm build` regenerates the native host, page bridge, and unpacked extension. `pnpm register` registers a verified build. `pnpm doctor` checks the built installation without changing project files.

For an offline font build, set `MITER_FONT_FILE` to a licensed `FiraCodeNerdFontMono-Regular.ttf` and `MITER_FONT_LICENSE` to its SIL OFL license text.

## Project

- `apps/extension`: SolidJS + WXT interface, previews, and xterm terminal.
- `apps/host`: native messaging, SQLite state, file operations, approved commands, and PTY sessions.
- `apps/inference`: optional local model process. Install its runtime with `pnpm models:install` and configure your GGUF file in Settings.
- `packages`: shared protocol, chat bridge, UI helpers, and terminal settings.
- `scripts`: build, setup, native registration, and asset verification.

State lives in `~/.mitter` or `MITTER_HOME`. Task edits use file hashes and journals. Commands require approval. Approved commands can affect files outside the project; Stop cannot undo every external effect. ChatGPT tab automation depends on the current browser session and website behavior.

This remains a release candidate. A passing local build does not prove authenticated ChatGPT behavior.

MIT license. See `LICENSE` and `THIRD_PARTY.md`.
