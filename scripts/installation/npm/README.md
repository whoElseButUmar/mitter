# Miter

Build and run local projects from Chrome with your signed-in ChatGPT session. Give Miter a task, review its changes, and open a live preview for supported web apps.

## Install on macOS

Use Chrome, npm, and Node.js 22 or newer.

```sh
npx miter-install@latest
```

The installer downloads and verifies the Mac bundle, then installs the extension files and local helper. See the [release downloads](https://github.com/whoElseButUmar/mitter/releases) for supported Mac architectures.

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select `~/Library/Application Support/Miter/extension`, or the folder the installer prints.
3. Open Miter from the Extensions menu in the Chrome profile where you use ChatGPT.

Open a project and start a task. For example, ask Miter to build a reading list where you can save books and mark them as read.

## Update and uninstall

Run `npx miter-install@latest` again to update. Reload Miter’s extension card and reopen the workspace. Updates keep your registered projects, tasks, and settings.

To uninstall, quit Chrome and run `miter uninstall`. Use `miter uninstall --purge` to remove saved Miter data too. Add `--dry-run` to review the paths first. Remove the extension from `chrome://extensions` in each profile where you loaded it.

[Installation guide](https://github.com/whoElseButUmar/mitter/blob/main/scripts/installation/README.md) · [Source code](https://github.com/whoElseButUmar/mitter) · [Report an issue](https://github.com/whoElseButUmar/mitter/issues)
