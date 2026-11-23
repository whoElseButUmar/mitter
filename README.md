<img align="right" src="apps/extension/public/icon-128.png" width="56" height="56" alt="">

# Miter

Build and run local projects from Chrome with your signed-in ChatGPT session. Open a folder, describe what you want to change, and follow the edits and checks in Miter.

Miter and ChatGPT exchange structured JSON. A local helper applies edits, runs checks, and sends results back so the task can continue. When a command needs approval, you review it in Miter.

## Get started on macOS

Use Chrome and Node.js 22 or newer to install Miter.

```sh
npx miter-install@latest
```

If you have the Mac installer ZIP, unzip it and open **Install Miter.command**. It includes Node.

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select `~/Library/Application Support/Miter/extension`, or the folder printed by your installer.
3. Open Miter from Chrome’s Extensions menu. Use the same profile where you sign in to ChatGPT.

Run the same command to update, then reload Miter’s extension card. [Install, update, and uninstall guide](scripts/installation/README.md)

## Try a task

Choose **Create project** or **Open existing project**, then **New task**.

> Build a reading list where I can save books, mark them as read, and find them again after a reload.

You can paste a screenshot into a new task or a follow-up. For a database-backed starting point, choose the **Vite + TypeScript + SQLite** starter. For supported web apps, open the live preview and manage its server from the project terminal.

## Documentation

Open **Help → Documentation** in Miter for the full user guide, setup help, and examples of the JSON messages.

- [Terminal commands](apps/host/src/cli/README.md) to start and monitor tasks.
- [App previews](apps/host/src/core/preview/README.md) and [browser checks](apps/host/src/core/quality/README.md), including accessibility and Lighthouse.
- [ChatGPT bridge](packages/bridge/README.md), [JSON protocol](packages/protocol/README.md), and [bundled skills](packages/protocol/src/task-skills/README.md).
- [Local model runtime](apps/inference/README.md) for an optional GGUF model.

## Development

To build from source, clone the repo and run `node scripts/setup.mjs` with Node.js 26 or newer.

After source setup, run `pnpm check` for formatting, type checks, and tests. Use `pnpm dev` to work on the SolidJS extension. `pnpm build` verifies the native helper and writes the unpacked extension to `apps/extension/.output/chrome-mv3`.

See the [native host guide](apps/host/README.md), [coding standards](CODING_STANDARDS.md), and [release checks](scripts/release-checks/README.md) when contributing.

[MIT license](LICENSE) · [Third-party notices](THIRD_PARTY.md)
