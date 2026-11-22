import type { DocsTopic } from './content-types';

export const architectureTopic: DocsTopic = {
  id: 'architecture',
  title: 'How Miter is built',
  summary: 'Follow a request from the Chrome side panel to ChatGPT, your project files, and the preview.',
  blocks: [
    { kind: 'heading', text: 'From prompt to preview' },
    {
      kind: 'steps',
      items: [
        'The workspace saves your task and asks the background worker to start it.',
        'For a ChatGPT task, the bridge links a browser tab and submits your instructions with a reply contract.',
        'ChatGPT proposes a batch in JSON. Miter checks who the reply belongs to, what it refers to, and whether its actions can run.',
        'The local helper applies accepted actions in the project and records the results. Miter sends those results back to ChatGPT when another turn is needed.',
        'Completion checks run on the changed project. For a supported web app, Miter opens the verified preview.',
      ],
    },
    { kind: 'heading', text: 'Parts of the codebase' },
    {
      kind: 'terms',
      items: [
        {
          name: 'apps/extension',
          description:
            'The Chrome side panel, full workspace, background worker, file viewer, and Docs. The UI uses SolidJS and CSS, packaged by WXT and Vite.',
        },
        {
          name: 'packages/bridge',
          description:
            'Connects the workspace to ChatGPT’s visible page, prepares sends, reads replies, and keeps track of interrupted exchanges.',
        },
        {
          name: 'packages/protocol',
          description:
            'Shared Zod schemas, message validation, built-in skills, and task instructions. Start here to look up what fields a message accepts.',
        },
        {
          name: 'apps/host',
          description:
            'The Node.js helper. Chrome Native Messaging connects to it over a local process. It owns files, SQLite task history, approval and execution, and local preview servers.',
        },
        {
          name: 'apps/inference',
          description:
            'The optional local GGUF model runtime through node-llama-cpp. Local generation runs on your computer.',
        },
        {
          name: 'packages/ui and packages/terminal',
          description:
            'Shared workspace controls, draft storage, and terminal settings. xterm.js draws the terminal in Chrome and node-pty connects it to a real local shell.',
        },
        {
          name: 'scripts',
          description:
            'Build, installation, diagnostics, and packaged Chrome verification. The checkout uses pnpm and Node.js 26 or newer.',
        },
      ],
    },
    { kind: 'heading', text: 'Choose the right place to look' },
    {
      kind: 'text',
      text: 'If you can open Miter and see a disconnected helper, start with Setup & connection. If the helper is connected and a chat stalls, open the task’s linked chat or its technical details. If the app opens and a feature fails, use the task’s Checks and the app’s terminal logs.',
    },
    {
      kind: 'links',
      items: [
        { id: 'chat-protocol', label: 'Follow the ChatGPT exchange' },
        { id: 'native-api', label: 'Read the local API contracts' },
        { id: 'troubleshooting', label: 'Find a recovery step' },
      ],
    },
  ],
};
