import type { DocsTopic } from './content-types';

export const protocolTopics: DocsTopic[] = [
  {
    id: 'chat-protocol',
    title: 'How Miter talks to ChatGPT',
    summary: 'Follow a task from its first prompt through file changes, checks, and the next reply.',
    blocks: [
      {
        kind: 'text',
        text: 'You describe the result you want. ChatGPT proposes a small batch of actions in JSON. The helper on your computer checks and carries out the permitted actions. Miter sends the results back and uses an exchange ID to match the next reply.',
      },
      {
        kind: 'steps',
        items: [
          'Miter opens or reconnects the ChatGPT tab linked to the task. It sends your goal, project context, acceptance checks, available command profiles, skills and the reply format.',
          'ChatGPT proposes actions such as reading a file or writing a new one. Miter checks that the reply belongs to this task and to the latest exchange.',
          'The local helper checks each action, applies permitted changes, and pauses when it needs a decision. A model reply can request a command. Approval comes from Miter or from a command profile you have already authorized.',
          'Miter sends a report with the results. ChatGPT keeps working in batches until the helper verifies completion, a decision is needed, or the task reaches its budget.',
        ],
      },
      {
        kind: 'heading',
        text: 'What travels through ChatGPT',
      },
      {
        kind: 'text',
        text: 'The automatic bridge uses your signed-in ChatGPT website. It prepares the prompt in the linked tab, submits it, and reads the resulting chat turn. The JSON below is the model reply contract. The extension and the helper communicate separately over Chrome Native Messaging.',
      },
      {
        kind: 'code',
        language: 'text',
        caption: 'Abbreviated outgoing ChatGPT prompt. The actual prompt supplies a complete reply contract.',
        text: [
          'MITTER EXCHANGE 6f8b89c4-5d4f-4b6e-8c6c-98c02a37b2c6',
          'Follow the task instructions in this text block. Return only the requested mitter/1 JSON reply.',
          '',
          '```text',
          'CURRENT REPLY CONTRACT (this exchange only)',
          '…',
          'GOAL: Add a keyboard shortcut for search.',
          '…',
          'BEGIN UNTRUSTED MITTER REPORT',
          '…',
          'END UNTRUSTED MITTER REPORT',
          '…',
          '```',
          '',
          'END MITTER EXCHANGE 6f8b89c4-5d4f-4b6e-8c6c-98c02a37b2c6',
        ].join('\n'),
      },
      {
        kind: 'text',
        text: 'A report can include file excerpts, earlier action results, errors and check findings, including the pieces needed to fix a failure. Report content is treated as data. Instructions embedded in a source file or command output carry no authority.',
      },
      {
        kind: 'note',
        text: 'Automatic browser tasks currently use ChatGPT. The codebase describes Gemini and Perplexity connections, but it has no automatic browser adapter for either. A local GGUF model is a separate execution mode.',
      },
      {
        kind: 'links',
        items: [
          { id: 'reply-shape', label: 'Read a complete ChatGPT reply' },
          { id: 'native-api', label: 'See the local API boundaries' },
          { id: 'reply-recovery', label: 'See what happens when a reply is missing or rejected' },
        ],
      },
    ],
  },
  {
    id: 'reply-shape',
    title: 'ChatGPT reply format',
    summary:
      'The full mitter/1 JSON envelope, an example, and the rules Miter uses to match a reply to a task.',
    blocks: [
      {
        kind: 'text',
        text: 'The reply envelope is a single JSON object that identifies the task and contains the next actions. Miter usually handles it for you. The examples and schemas here show what to send when you use Manual handoff or debug a reply.',
      },
      {
        kind: 'code',
        language: 'json',
        caption:
          'A first reply that lists the project and reads its HTML entry point. Use the IDs from your own current prompt.',
        text: JSON.stringify(
          {
            protocol: 'mitter/1',
            id: 'reply_001',
            replyTo: '6f8b89c4-5d4f-4b6e-8c6c-98c02a37b2c6',
            workerId: 'task_001',
            projectId: 'project_001',
            summary: 'Inspect the project entry point.',
            actions: [
              { type: 'list', path: '.' },
              { type: 'read', path: 'index.html' },
            ],
          },
          null,
          2,
        ),
      },
      {
        kind: 'terms',
        items: [
          {
            name: 'protocol',
            description: 'The literal string mitter/1. Miter’s release number is separate.',
          },
          {
            name: 'id',
            description:
              'A fresh reply or batch ID. A reply already accepted under this ID cannot apply its actions twice.',
          },
          {
            name: 'replyTo',
            description:
              'The exact exchange ID from the current prompt. The automatic bridge requires it. The base handoff format also supports manual replies without it when no linked exchange is required.',
          },
          {
            name: 'workerId',
            description: 'The task ID. A worker is the local record that owns a task and its execution.',
          },
          { name: 'projectId', description: 'The registered project that owns this task.' },
          {
            name: 'summary',
            description:
              'A brief account of this batch. It does not establish that its actions ran or that any checks passed.',
          },
          {
            name: 'actions',
            description:
              'An ordered list of action objects. Each has a type and fields specific to that type.',
          },
        ],
      },
      {
        kind: 'heading',
        text: 'Limits and formatting',
      },
      {
        kind: 'list',
        items: [
          'Return one complete JSON object inside one fenced code block labeled json for automatic ChatGPT replies. Send only that block. The manual parser also accepts a complete bare JSON object.',
          'Use double quotes, JSON string escaping and ordinary spaces for indentation. Escape newlines inside a source string as \\n. Preserve escaped quotes, literal backticks and backslashes in the file text.',
          'The schema accepts 1–16 actions. Prompts ask the model for at most 8 per turn. Keep each batch focused and put finish last when included.',
          'The original reply is limited to 400,000 UTF-8 bytes, including fences. Expanded bundled assets also count against their validation budget. Individual source strings can have up to 120,000 UTF-16 code units.',
          'IDs in an envelope use 1–100 ASCII letters, digits, underscores or hyphens. Send the IDs supplied for this task and exchange exactly as provided. Extra fields on an envelope or action are rejected.',
        ],
      },
      {
        kind: 'note',
        text: 'The schemas below describe the shapes. Miter also checks runtime rules such as the active exchange, the order of finish, command approval, and whether a file still matches a recorded read.',
      },
      { kind: 'schema', schema: 'reply' },
      { kind: 'schema', schema: 'proposal' },
      {
        kind: 'heading',
        text: 'Copy a reply by hand',
      },
      {
        kind: 'steps',
        items: [
          'Open the task’s Actions menu and choose Manual handoff → Setup prompt. Copy the instructions into the chat you will use for this task.',
          'Copy the complete reply and return to Manual handoff → Paste handoff. Review which task the reply will apply to.',
          'Use Review report to give the chat the latest results before asking for another batch. Use the active reply contract if you are recovering an existing automatic exchange.',
        ],
      },
      {
        kind: 'heading',
        text: 'Local model and Rewrite formats',
      },
      {
        kind: 'text',
        text: 'A local coding model returns a bare JSON object with summary and 1–8 actions. The helper adds the task identity and validates the proposals locally. The Rewrite tool uses a smaller, separate contract. A ChatGPT rewrite returns protocol miter-rewrite/1, the same requestId supplied in the rewrite prompt, and the replacement text. You review that text before applying it.',
      },
      {
        kind: 'code',
        language: 'json',
        caption: 'A read-only local model proposal.',
        text: JSON.stringify(
          { summary: 'Find the page entry point.', actions: [{ type: 'list', path: '.' }] },
          null,
          2,
        ),
      },
      { kind: 'schema', schema: 'rewriteRequest' },
      { kind: 'schema', schema: 'rewriteReply' },
      {
        kind: 'links',
        items: [
          { id: 'action-reference', label: 'See every supported action' },
          { id: 'reply-recovery', label: 'Recover a malformed, stale, or missing reply' },
        ],
      },
    ],
  },
  {
    id: 'action-reference',
    title: 'Actions and completion checks',
    summary:
      'The complete set of actions a model can propose, the required fields, and when Miter needs approval.',
    blocks: [
      {
        kind: 'text',
        text: 'Actions are requests to Miter. The model can ask to read a file, edit a file, run a registered check, or finish the task. The helper decides what can run under the current task, file version, and approval.',
      },
      { kind: 'heading', text: 'Inspect files and packaged guidance' },
      {
        kind: 'terms',
        items: [
          {
            name: 'list',
            description:
              'List a directory. Supply path, or omit it to list the project root. A legacy null path also means the root.',
          },
          {
            name: 'read',
            description:
              'Read one file by path. Optional offset and limit are UTF-16 code-unit offsets and lengths. Follow nextOffset until readComplete before rewriting a whole file.',
          },
          {
            name: 'search',
            description:
              'Look for the literal query in the project. The query can have up to 200 UTF-16 code units.',
          },
          {
            name: 'diff',
            description:
              'Inspect the working diff. It takes no additional fields and requires a Git repository to show a diff.',
          },
          {
            name: 'skill',
            description:
              'Read a packaged skill by name. Optional asset reads a packaged file belonging to that skill. Use the exact names in the prompt.',
          },
        ],
      },
      { kind: 'heading', text: 'Edit files without overwriting newer work' },
      {
        kind: 'terms',
        items: [
          {
            name: 'write',
            description:
              'Supply path and the complete content, together with base or expectedHash. A bundled write supplies asset in place of content.',
          },
          {
            name: 'replace',
            description:
              'Supply path, before, after, and base or expectedHash. The before text must match exactly once in that file at this point in the batch.',
          },
          {
            name: 'generateImage',
            description:
              'Ask Miter to generate one original image in ChatGPT’s Create image mode. Send this action by itself with a short visual prompt, then wait for Miter to report that the image is ready.',
          },
          {
            name: 'saveImage',
            description:
              'Save a PNG, JPEG, WebP or GIF up to 5 MiB. Use source.type web with a direct public HTTPS url, or source.type generated with the one-based index of a generated image in the linked chat. Miter saves a smaller WebP when optimization reduces size and preserves animation. Use the returned path and dimensions when editing the app.',
          },
          {
            name: 'base',
            description:
              'Use the exact read reference issued by the helper for that file version. It starts with r_ followed by 16 lowercase hex digits. Use the literal missing only when writing a genuinely new file.',
          },
          {
            name: 'expectedHash',
            description:
              'The exact lowercase SHA-256 from a read or a recent successful edit to the same file. This is an alternative to base. An exact-hash write can also use missing for a new file.',
          },
        ],
      },
      {
        kind: 'text',
        text: 'Paths are relative to the project and use forward slashes. Read a file before making a full replacement. Consecutive edits can be checked as a batch, and an external change makes a stale precondition fail. An old read reference, a guessed hash, a path outside the project, and a write to an excluded dependency folder all fail admission or preflight.',
      },
      {
        kind: 'code',
        language: 'json',
        caption: 'Two example write actions. A complete reply puts actions inside the envelope.',
        text: JSON.stringify(
          [
            {
              type: 'write',
              path: 'notes.txt',
              base: 'missing',
              content: 'Keyboard shortcuts\nPress / to search.\n',
            },
            { type: 'write', path: 'foundation.css', asset: 'foundation.css', base: 'missing' },
          ],
          null,
          2,
        ),
      },
      {
        kind: 'text',
        text: 'The packaged write assets are components.mjs, foundation.css, and vite-api.mjs. The helper copies their packaged source into the write after resolving the asset name. It still checks the destination path and file version.',
      },
      { kind: 'heading', text: 'Commands, teammates, and decisions' },
      {
        kind: 'terms',
        items: [
          {
            name: 'command',
            description:
              'Run the registered command identified by profileId. A profile belongs to the project and records the reviewed executable, exact arguments and timeout.',
          },
          {
            name: 'setupCommand',
            description:
              'Request one setup operation with command, purpose and effects. command is an array containing the executable followed by literal arguments. The helper runs an approved command from the task folder.',
          },
          {
            name: 'team_message',
            description:
              'Share message text with a peer using optional to. Omit to to share it with the team.',
          },
          {
            name: 'team_pause',
            description:
              'Ask to hold the peer identified by workerId. Include reason. Optional seconds can be 10–300, with 120 as the default for omission or null.',
          },
          {
            name: 'team_resume',
            description:
              'Request resumption for the peer identified by workerId and provide context. Peer messages do not grant command or file permissions.',
          },
          { name: 'ask', description: 'Present a question that needs a user decision.' },
          {
            name: 'finish',
            description:
              'Request completion and provide summary. Optional openPreview accepts literal true for a user-requested launch of an existing supported development project.',
          },
        ],
      },
      {
        kind: 'code',
        language: 'json',
        caption: 'A setup request that prompts for a decision before installation.',
        text: JSON.stringify(
          {
            type: 'setupCommand',
            command: ['pnpm', 'install'],
            purpose: 'Install the dependencies declared in package.json.',
            effects: 'Downloads packages and may write node_modules and pnpm-lock.yaml in the task folder.',
          },
          null,
          2,
        ),
      },
      {
        kind: 'text',
        text: 'The setup dialog displays the command, working folder, purpose and expected effects. Run it approves one occurrence. I’ll do it myself opens a project terminal so you can run it. You can also decline or give different instructions. Miter reports the recorded outcome before the model plans dependent work.',
      },
      { kind: 'schema', schema: 'action' },
      { kind: 'schema', schema: 'envelope' },
      { kind: 'schema', schema: 'commandProfile' },
      { kind: 'heading', text: 'How Miter decides a task is ready' },
      {
        kind: 'terms',
        items: [
          { name: 'exists', description: 'Passes when the configured path exists.' },
          { name: 'contains', description: 'Passes when the specified file contains the exact text.' },
          { name: 'command', description: 'Runs the configured profileId as a completion check.' },
        ],
      },
      {
        kind: 'text',
        text: 'Acceptance checks are chosen by the user or supplied by Miter. Model actions cannot replace them. Supported web projects also have a quality gate that checks the app in an isolated browser. A failed check returns findings for a repair batch. A completed task without applicable verification can report Finished with the checks marked as not run.',
      },
      { kind: 'schema', schema: 'check' },
    ],
  },
  {
    id: 'task-data',
    title: 'Tasks, follow-ups, and attachments',
    summary: 'What Miter saves for a task, what changes when you steer, and how images travel with a prompt.',
    blocks: [
      {
        kind: 'text',
        text: 'The helper stores registered projects and task history locally. A project identifies a folder and its settings, including registered command profiles. A worker is a task record containing its project, goal, coding source, current run state, work queue and observed results.',
      },
      {
        kind: 'terms',
        items: [
          {
            name: 'Task creation',
            description:
              'worker.create identifies a project and takes a goal and a mode of handoff or local. Name, checks, initial limits, workspace choice, image references and a reviewed preview capture can accompany it.',
          },
          {
            name: 'Task state',
            description:
              'The full worker record also contains a task ID, run ID, queued batches, action cursor, observations and run limits. Optional fields hold current approval, completion evidence, worktree details and follow-up state.',
          },
          {
            name: 'Run boundary',
            description:
              'Sensitive requests can include expectedRun with runId and epoch. If the current run changed after the user reviewed it, the old request cannot take over the newer run.',
          },
          {
            name: 'Edit task',
            description:
              'The task editor can change the title and goal before the task has run. Use a follow-up to change the instruction after it has run.',
          },
        ],
      },
      { kind: 'schema', schema: 'workerCreate' },
      { kind: 'schema', schema: 'worker' },
      { kind: 'heading', text: 'Queue a follow-up or steer a run' },
      {
        kind: 'text',
        text: 'Queue follow-up waits for a safe point. Steer now replaces the outstanding plan and keeps work already applied. Both use a stable request ID, the instruction text and optional context. A retry of the same request can be recognized by its ID.',
      },
      {
        kind: 'code',
        language: 'json',
        caption:
          'A local worker.followup request. The workerId belongs to params, outside the nested follow-up request.',
        text: JSON.stringify(
          {
            id: 'local_request_01',
            method: 'worker.followup',
            params: {
              workerId: 'task_001',
              request: {
                id: 'followup_001',
                instruction: 'Make the search shortcut work in the table view.',
                autoStart: true,
              },
            },
          },
          null,
          2,
        ),
      },
      {
        kind: 'text',
        text: 'A follow-up from a code selection can include path, the original file’s hash, start, end and text. Offsets count UTF-16 code units and end is exclusive. The helper rechecks that the file and selection still match before using it. autoStart defaults to true. The stored follow-up adds workerId, state, timestamps and its base run ID.',
      },
      { kind: 'schema', schema: 'followup' },
      { kind: 'heading', text: 'How attachments are saved and sent' },
      {
        kind: 'text',
        text: 'Every image has an ID, name, media type and byte size. Miter keeps the original bytes in IndexedDB in the Chrome profile that attached them. Task and follow-up records store references. This lets Miter restore a draft after reload and keep its images when you Rewrite the text.',
      },
      {
        kind: 'code',
        language: 'json',
        caption: 'One image reference. This metadata alone cannot recreate the image.',
        text: JSON.stringify(
          {
            id: '3c0b9c77-48d7-42fe-a032-a94a6b2891ac',
            name: 'search-dialog.png',
            type: 'image/png',
            size: 28104,
          },
          null,
          2,
        ),
      },
      {
        kind: 'text',
        text: 'Start, Send, and activated follow-ups upload images to the linked ChatGPT composer. Miter waits for the expected files to finish uploading before triggering Send. Each draft accepts up to four PNG, JPEG, WebP or GIF files of up to 5 MiB each. Use the profile where you attached the files when resuming an unsent task.',
      },
      { kind: 'schema', schema: 'image' },
      {
        kind: 'links',
        items: [
          { id: 'chat-protocol', label: 'Follow the model exchange from start to finish' },
          { id: 'native-api', label: 'See other local API shapes' },
        ],
      },
    ],
  },
  {
    id: 'native-api',
    title: 'Local API and page bridge',
    summary:
      'The internal request and response formats, method families, preview sessions, and browser messages.',
    blocks: [
      {
        kind: 'text',
        text: 'Miter’s local helper receives requests from the extension to work with projects and tasks. The ChatGPT adapter uses a separate browser channel to observe the linked page and prepare or submit a message. Both channels run on your computer.',
      },
      { kind: 'heading', text: 'Native request and response' },
      {
        kind: 'code',
        language: 'json',
        caption: 'A read-only request to check whether the helper has seen a particular batch.',
        text: JSON.stringify(
          {
            id: 'local_request_02',
            method: 'worker.handoffSeen',
            params: { workerId: 'task_001', envelopeId: 'reply_001' },
          },
          null,
          2,
        ),
      },
      {
        kind: 'code',
        language: 'json',
        caption: 'A successful acknowledgement. A failed response has ok set to false and an error string.',
        text: JSON.stringify({ id: 'local_request_02', ok: true, result: { seen: true } }, null, 2),
      },
      {
        kind: 'text',
        text: 'The response ID correlates this request and response. It is independent of the ChatGPT exchange ID and the model’s reply ID. Method-specific parameters and results still need validation. Large native responses use ordered fragments and are reassembled before parsing.',
      },
      { kind: 'schema', schema: 'request' },
      { kind: 'schema', schema: 'response' },
      {
        kind: 'terms',
        items: [
          {
            name: 'state / system.*',
            description:
              'Read the project and worker snapshot, check readiness or health, and list, create or verify local state backups.',
          },
          {
            name: 'project.* / settings.*',
            description:
              'Pick and register folders, create projects, open starter tasks, manage project context and command profiles, and configure the optional local model.',
          },
          {
            name: 'worker.*',
            description:
              'Create and control tasks, inspect files, view activity, queue follow-ups, validate or import replies, manage approvals and open previews. worker.validateReply checks a proposed reply. worker.import separately decides whether to accept it for execution.',
          },
          {
            name: 'worker.bridgeLoad / worker.bridgeSave / worker.bridgeExtend',
            description:
              'Load, persist or extend the recorded state of a browser run. A saved receipt participates in duplicate protection and restart recovery.',
          },
          {
            name: 'workflow.*',
            description: 'Record, save, replay, or delete user-reviewed workflows attached to a project.',
          },
          {
            name: 'Preview session',
            description:
              'A temporary local HTTP server bound to the task run. Its previewId and URL identify an exact session. Restart replaces that session. Stop targets one session so a delayed request cannot stop a replacement.',
          },
        ],
      },
      { kind: 'schema', schema: 'preview' },
      { kind: 'heading', text: 'Browser page messages' },
      {
        kind: 'text',
        text: 'The isolated adapter is packaged with Miter. Its channel is mitter-page/4. A hello message checks compatibility. A request names the operation and the linked tab’s expected conversation. The reply carries a matching message ID and endpoint instance ID.',
      },
      {
        kind: 'terms',
        items: [
          {
            name: 'probe / inspect / reply / control',
            description: 'Observe page readiness, transcript or reply state, or the current control state.',
          },
          {
            name: 'prepare / attach_image / commit',
            description:
              'Stage exact prompt text, upload and verify each expected image, then submit from the document that prepared it. messageId identifies the send intent and composerSession identifies the prepared document.',
          },
          {
            name: 'send / clear_draft / stop / interrupt',
            description:
              'Other composer and control operations guarded by the adapter. Clear draft requires proof of ownership. Stop retires the automation. Interrupt targets generation in the linked conversation.',
          },
        ],
      },
      {
        kind: 'text',
        text: 'For an image-bearing send, the page request carries an ordered image manifest and an optional Base64 payload for one image at a time. The adapter can poll for its upload without resending the bytes. These are internal transport fields. The model receives image attachments through the ChatGPT composer.',
      },
      { kind: 'schema', schema: 'pageRequest' },
      { kind: 'schema', schema: 'pageReply' },
    ],
  },
  {
    id: 'reply-recovery',
    title: 'Missing, duplicate, or rejected replies',
    summary: 'Understand what a paused exchange means and when it is safe to continue, repair, or resend.',
    blocks: [
      {
        kind: 'text',
        text: 'If ChatGPT is still writing, leave the task on its linked conversation. Miter waits for one complete reply and checks it against the saved send. You can inspect the current status or open the linked chat when the task needs attention.',
      },
      {
        kind: 'terms',
        items: [
          {
            name: 'Malformed or incomplete JSON',
            description:
              'Miter may request a fresh, complete batch. The original response has no effect if it was rejected before import.',
          },
          {
            name: 'Wrong replyTo or mismatched IDs',
            description:
              'The reply belongs to a different exchange, task, or project. Use the IDs in the current prompt. Do not recycle an earlier reply.',
          },
          {
            name: 'Already imported reply',
            description:
              'The helper tracks accepted reply IDs and exchanges. Reopening or retrying the same exchange does not grant another execution.',
          },
          {
            name: 'BASE_REQUIRED / BASE_CONFLICT',
            description:
              'Supply one file version field, base or expectedHash. An edit without one cannot run.',
          },
          {
            name: 'Stale file version or failed replacement',
            description:
              'Read the file again. Keep changes already applied and repair the remaining work against the current version. A replace needs a unique exact before match.',
          },
          {
            name: 'Command needs approval',
            description:
              'Review the exact command or use the task’s terminal when you choose to do it yourself. Wait for the result before asking Miter to continue.',
          },
          {
            name: 'Completion checks failed',
            description:
              'The report names the failed check. Miter uses this evidence to request a repair within the task budget.',
          },
          {
            name: 'RPC_RESULT_INVALID',
            description:
              'The helper’s acknowledgement could not be validated. Because an operation may have already completed, Miter checks the saved state before any further action.',
          },
        ],
      },
      {
        kind: 'heading',
        text: 'What recovery preserves',
      },
      {
        kind: 'text',
        text: 'Before clicking Send, Miter saves a receipt for the exact outgoing prompt. When it reconnects, it uses that receipt to look for the message and its reply. When the result is uncertain, it observes the linked chat before trying another send. An unrelated draft is left in place.',
      },
      {
        kind: 'text',
        text: 'Use Resend prompt only when Miter offers it and you have reviewed the pending instructions. It creates a new exchange for that reviewed prompt when no usable reply has arrived. Accepted batches and completed edits stay recorded. In a repair batch, use the current replyTo and fresh reads where the files changed.',
      },
      {
        kind: 'links',
        items: [
          { id: 'reply-shape', label: 'Check the JSON reply format' },
          { id: 'action-reference', label: 'Check action fields and file version rules' },
        ],
      },
    ],
  },
];
