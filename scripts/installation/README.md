# Local installation

## Install or update with npx

The npm package is pending publication. Once it’s available, run this command on macOS with Node.js 22 or newer for both installs and updates.

```sh
npx miter-install@latest
```

The command downloads the prebuilt bundle for your Mac, verifies its SHA-256 checksum, and runs the managed installer. It keeps your project registrations, task history, and settings during an update.

On first install, use **Load unpacked** in `chrome://extensions` and pick the folder printed by the installer. For updates, click **Reload** on Miter’s extension card. Add `--chromium` for Chromium or `--destination=PATH` for a custom managed folder. Use the same options when updating a custom installation.

### Prepare an npm release

Run `pnpm build` and `pnpm bundle:local` on each Mac architecture you plan to support. Upload the resulting ZIPs to an HTTPS release directory where each ZIP can be downloaded directly. Keep the generated `.sha256` files beside the local ZIPs for packaging.

```sh
pnpm bundle:npm https://github.com/OWNER/REPO/releases/download/TAG path/to/apple-silicon.zip path/to/intel.zip
```

Pass the ZIP paths exactly as printed by `pnpm bundle:local`. The command accepts one ZIP per architecture and requires matching versions. It creates the `miter-install` tarball in `.cache/npm/`. Smoke-test the final tarball with `npx --package=/absolute/path/to/miter-install-VERSION.tgz miter-install` before publishing it. Publishing the tarball with npm’s `latest` tag makes that version available to new installs and updates.

## Install from source or a ZIP

On macOS with Node.js 26 or newer, run `node scripts/setup.mjs` from the checkout. Setup installs dependencies using the pinned pnpm version and existing `allowBuilds` policy, builds the app, checks the native runtime, and installs a managed copy in `~/Library/Application Support/Miter`. Unknown dependency build scripts stop setup for review; setup never approves them automatically.

For a first installation, load `~/Library/Application Support/Miter/extension` using Chrome's **Extensions → Developer mode → Load unpacked**. If Chrome already loads Miter from this managed folder, reload Miter in `chrome://extensions` after an update, then close and reopen the workspace.

If Chrome currently loads Miter from a source checkout, keep that checkout and its existing Chrome entry. Reload uses the currently loaded folder; installing the managed copy does not change that path. Source-to-managed migration is a separate, explicit Chrome step, and this installer does not verify storage retention for that transition. Keep the source checkout until the loaded folder has been deliberately changed and the workspace, connection and settings verified. Do not uninstall the existing extension as a migration step: Chrome [clears extension-local storage when an extension is removed](https://developer.chrome.com/docs/extensions/reference/api/storage#storage_areas). The host database and its backups are separate from Chrome's extension settings.

Options:

- `--destination=PATH` selects an empty folder or an existing managed installation.
- `--chromium` registers the host with Chromium.
- `--build-only` builds the source without a managed install or registration.

`pnpm bundle:local` packages an already built checkout into `.cache/installers/Miter-VERSION-ARCH-HASH` and a matching `.zip` with a `.zip.sha256` checksum. The ZIP is extracted and its runtime tested before publication. Unzip it anywhere, then run `Install Miter.command` inside the extracted folder to install or update without npm, pnpm, network access or a separately installed Node. The same destination/browser options work on that launcher. The bundle includes the current Mac's Node runtime, pinned pnpm executable, native dependencies and full license files. Framework previews use the bundled pnpm even when Chrome starts without your shell environment. Native prebuilds for other operating systems and architectures are excluded. Finder's `.DS_Store` metadata does not affect bundle verification; other unexpected files and changed assets still fail verification. If Node's license is stored elsewhere, set `MITER_NODE_LICENSE` to that distribution's LICENSE before creating the bundle.

The installer checks a closed file/hash inventory, build assets, SQLite, terminal startup and isolated app tests before changing registration. Hashes detect incomplete or changed local files; they are not a publisher signature. The bundle is for the macOS architecture on which it was built, without signing or notarization.

Each update keeps an immutable release and switches the launcher atomically. The stable extension folder retains old hashed chunks for tabs that have not reloaded yet. Registration errors restore the prior extension files, launcher and active-release marker. Interrupted first installs retain an ownership marker so they can be retried; a complete matching first-marker temporary file can be promoted under the installation lock, while incomplete or unrelated files remain untouched; concurrent installers are refused. The macOS kernel releases the installation lock when the installer exits or is killed, so retry does not require deleting a lock file. The zero-byte `.installation.lock` file stays in place and must not be removed. Retry removes only unpublished `.installing-*` copy directories under the locked managed release folder, while retaining every published release. A legacy `.install-lock` directory from an older installer cannot be recovered automatically because it records no process owner; close any older installer before removing that directory and retrying. Previous releases are retained deliberately, and there is no automatic pruning while a host may still be running. If a retained release is damaged, rerun the same installer: it creates and verifies a fresh repair copy, then switches registration. The damaged directory stays untouched for any host still using it; subsequent installs reuse the verified active copy.

Miter state stays in `~/.mitter` or the configured data folder. Without an explicit `MITTER_HOME`, the installer preserves the exact data path from recognized managed or source registration launchers. Conflicting paths stop installation rather than selecting a different database; an explicit `MITTER_HOME` selects the intended folder, and an explicitly empty value selects the default. Installation does not open that database, kill active hosts, install optional inference models, or change Chrome preferences. Once installed, the installer bundle can move or be removed. Keep the managed destination, and retain any source checkout that Chrome still loads.

For a read-only check, run `node scripts/doctor.mjs` (`--chromium` for Chromium), or use the installed release's `runtime/node` with its `scripts/doctor.mjs`. Missing production assets, required dependencies, runtime prerequisites or registration return a nonzero exit code. Diagnostics check launcher permissions, referenced runtime paths, and managed release integrity without executing the launcher; stale registrations point to rerunning the installer. Diagnostics do not prove a live Chrome connection; Miter's connection panel shows that state.

The installer includes `bin/miter` for terminal task control and safely links `~/.local/bin/miter` when that name is free or already points to this installation. It leaves unrelated commands and shell profiles unchanged. If `~/.local/bin` is not on PATH, use the full command path printed by setup. Source registration similarly provides `~/.mitter/native/miter`. See the [terminal command reference](../../apps/host/src/cli/README.md) for start, status, watch and stop commands.

## Uninstall

Quit Chrome to stop Miter's local helper. Then choose one command.

| Command                   | What it removes                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `miter uninstall`         | The managed extension files, local helper, matching browser registration and `miter` shortcut. Saved local data is available on reinstall.                                   |
| `miter uninstall --purge` | The managed install plus its local tasks, settings, edit history, backups, quality reports and saved preview databases. Review the listed paths and type `PURGE` to confirm. |

Add `--dry-run` to either command to see the paths first. If `miter` is unavailable on your PATH, use `"$HOME/Library/Application Support/Miter/bin/miter"` or the command path printed by your installer. Project folders, the source checkout, and isolated worktrees are preserved.

Open `chrome://extensions` in each profile where you loaded Miter and choose **Remove**. Chrome clears that profile's Miter settings and unsent drafts when you remove the extension.

These commands are for the managed macOS installation. For a checkout registered directly with `pnpm register`, use `pnpm register --remove` from that checkout to unregister its helper.
