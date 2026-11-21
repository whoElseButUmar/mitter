# RC.60 verification: restarting Chrome during project setup

## What failed in RC.59

Fern Tray was waiting for a decision on `pnpm install` while ChatGPT was replying to Weave Shelf in a separate conversation. After a full Chrome quit and relaunch into a blank Work window, Miter recovered Weave’s reply. Closing Chrome had paused Fern’s task and cleared its pending command, even though the extension’s saved progress still said it was waiting for approval. Fern showed **Paused**, with no install decision left to make. The original Fern run remained paused.

The trial also exposed a second issue during concurrent starts. ChatGPT sometimes restored one task’s draft in another task’s new tab. Miter treated it as a conflicting draft and stopped the new task before its first send.

## What changed in RC.60

The local helper preserves an unanswered setup request when its fingerprint still matches the saved action and there is no record that execution began. The extension reopens the task’s original chat and waits for the user’s decision. If the manual install finishes before the extension reconnects, the helper identifies the completed batch so the extension can send its result once. If a command may already have started, Miter pauses for review.

For concurrent starts, Miter waits for each new chat to acquire its own conversation URL. It clears a restored draft only when the content matches a confirmed send from another Miter task. An unrecognized draft stays in place.

## Live test on November 21, 2026

Two fresh Vite and TypeScript projects ran against real ChatGPT in the same Chrome Work profile. Each build prompt included “I’ll run pnpm install.” Each project also ran a read-only field guide task. All four tasks had distinct, acknowledged sends in flight at the same time.

1. Quit Chrome completely while **Weave Shelf** showed its unanswered install request and **Fern Tray** was generating a reply. Reopened Work with only a blank tab. Miter reopened both original conversations.
2. Verified that Weave retained the same approval fingerprint, command, project folder and run. Fern accepted the reply to its original send exactly once. Chose **I’ll do it myself** in each project and entered `pnpm install` once per terminal. Both commands exited successfully and both live previews opened automatically.
3. With both apps serving, started another read-only task in each project. Both servers returned HTTP 200 with the correct app titles while the two tasks were waiting for replies. Both tasks finished using their own project’s source.

| Work completed                    | Tasks |  Sends | Accepted replies |
| --------------------------------- | ----: | -----: | ---------------: |
| App builds                        |     2 |      8 |                8 |
| Field guides during the builds    |     2 |      4 |                4 |
| Source checks with both apps live |     2 |      4 |                4 |
| **Total**                         | **6** | **16** |           **16** |

All six tasks finished with zero duplicate sends, cross-project replies, follow-up prompts or Resume actions. The visible ChatGPT transcripts matched the recorded exchanges for both builds.

On desktop and mobile, Fern Tray retained its cuttings and rooting status after reload. Weave Shelf retained its samples, archive status and order. Both previews passed the browser and automated accessibility checks and scored 100 in every scored Lighthouse category in this run.
