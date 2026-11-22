# Miter

Miter is a Chrome workspace for building and editing local projects. Give it a task in plain language. The extension works with your signed-in ChatGPT session, and a native host applies file edits and runs checks on your computer. You can also configure a local GGUF model.

## Get started on macOS

1. Unzip the Miter bundle and open **Install Miter.command**. The bundle includes Node and its dependencies.
2. In Chrome, open **Extensions**, enable **Developer mode**, choose **Load unpacked**, and select `~/Library/Application Support/Miter/extension`.
3. Open Miter and choose **Create project** or **Open existing project**.
4. Select **New task**, describe what you want, and start. For example, “Build a reading list where I can save books, mark them as read, and find them again after a reload.”

To install from source, use Node.js 26 or newer and run `node scripts/setup.mjs`. Setup downloads the pinned dependencies and terminal font. For updates, reload the Miter card in Chrome and reopen the workspace. If Chrome already loads Miter from a source checkout, follow the [installation and migration guide](scripts/installation/README.md) before moving it. Local installer bundles are unsigned.

## How a task runs

The extension sends the task and relevant project context to the selected model. The native host checks proposed file edits against recorded reads, journals changes, and runs registered project commands with approval. Approved commands run with your user permissions. Stopping a task cannot undo their external effects. Projects and task history live in `~/.mitter` or the configured `MITTER_HOME`.

For a framework or another language, ask for the stack you want. Miter can write project files such as `package.json`, `pyproject.toml` and `Cargo.toml`. If you say “I’ll run pnpm install,” Miter opens the setup dialog once the project manifest is ready. The dialog shows the command, working folder, purpose and expected changes. You can copy it, decline, suggest an alternative, or approve it once with **Run it**. **I’ll do it myself** opens a fresh terminal in the task folder and waits for you to enter a command. Miter reports its exit status and limited, redacted output to the task. Your keystrokes and ordinary shell history stay private.

**Ponytail** applies to coding tasks by default. It directs the model to reuse existing code and shared components, keep changes easy to read, and check the behavior it changed. **Caveman** keeps task updates concise. **No AI Slop** guides writing and UI copy. New local and ChatGPT tasks get the bundled guidance automatically. See the [skill definitions and credits](packages/protocol/src/task-skills/README.md).

For dependency-free Node projects, Miter runs the `*.test.mjs` files a task creates or edits in a sandbox and records the result at completion. Projects that need installed packages can use a registered test command.

For supported web apps, Miter checks shared controls, runs domain tests, and exercises browser journeys in isolated Chrome profiles. It flags a status printed twice in the same row, subtitles that repeat nearby controls or empty-state instructions, and common promotional phrases, unless you asked for that copy. Every scored Lighthouse category must reach 100 on desktop and mobile. Findings go back to the model for repair within the task budget. The reports describe the tested version and workflows. See [what the quality checks cover](apps/host/src/core/quality/README.md).

When a coding task builds or changes a static HTML, Vite, or Next.js app, Miter opens its preview in Chrome after verification. To launch an existing Vite or Next.js project, open its folder, choose **New task**, and enter **“Install dependencies with pnpm, start the dev server, and open the app preview.”** Miter installs dependencies in a private working copy and opens the app when the server is ready. This launch runs locally without a chat account.

Choose **Run** on a completed app to start it in the project’s **Terminal**. Its header shows the selected app with **Open app**, **Restart**, and **Stop** controls; hover or focus an icon for its label. Server status stays visible, and **Logs** opens startup output when needed. Use the session picker to switch apps and shells, and **Settings → Terminal appearance** to change fonts and colors. Choosing **Run** again selects the existing session. Apps with a Node backend can serve an API and keep data across preview sessions. **Setup & connection** shows how to recover a disconnected host or chat. For scripting, the [terminal command](apps/host/src/cli/README.md) starts and monitors tasks through the same running extension.

To keep a regression test for a project, open **Actions → Workflows** and start a recording. Exercise the app in the recording window using test data. Choose the element you expect to see at the end, name the workflow, and save it. Enable the restart check to verify that the result survives a fresh browser and server. Miter replays saved workflows on disposable data during web app verification. You can also replay or remove a workflow from the same menu.

## Where to find the code

| Location                                                                        | Responsibility                                                                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [apps/extension](apps/extension)                                                | Chrome workspace, background controller, preview, and terminal UI. Built with SolidJS and WXT.                   |
| [packages/bridge](packages/bridge/README.md)                                    | Chat tabs, prompt delivery, reply reading, and reconnecting interrupted tasks.                                   |
| [packages/protocol](packages/protocol/README.md)                                | Shared message schemas, task skills, and validation of proposed actions.                                         |
| [apps/host](apps/host/README.md)                                                | Native messaging, project files, SQLite state, command approvals, and task execution.                            |
| [apps/inference](apps/inference/README.md)                                      | Optional local model process. Install its runtime with `pnpm models:install` and select a GGUF file in Settings. |
| [packages/ui](packages/ui/README.md) and [packages/terminal](packages/terminal) | Shared UI behavior, preview messages, and terminal settings.                                                     |
| [scripts](scripts)                                                              | Installation, build verification, diagnostics, and release checks.                                               |

## Development

From a source checkout with Node.js 26 or newer:

```sh
node scripts/setup.mjs --build-only
pnpm check
pnpm dev
```

`pnpm check` runs formatting, source standards, type checks, and tests. `pnpm build` builds and verifies the native host, page bridge, preview sandbox, and unpacked extension. `pnpm run doctor` checks Miter’s native host registration and installed build. `pnpm bundle:local` produces the macOS installer folder and ZIP for the current architecture. For an offline font build, point `MITER_FONT_FILE` and `MITER_FONT_LICENSE` at the licensed terminal font and its SIL OFL license.

See the [coding standards](CODING_STANDARDS.md) and [release checks](scripts/release-checks/README.md) for contributor instructions. Miter is a release candidate. [MIT license](LICENSE) · [Third-party notices](THIRD_PARTY.md).
