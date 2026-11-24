import type { DocsTopic } from './content-types';

export const guideTopics: DocsTopic[] = [
  {
    id: 'introduction',
    title: 'Introduction',
    summary: 'Use Miter to turn a request into working files, checks and a preview on your computer.',
    blocks: [
      {
        kind: 'text',
        text: 'Give Miter a folder and a task in your own words. It can build a small app, fix something in an existing project, or investigate how the project works. You can see what changed as it goes.',
      },
      {
        kind: 'terms',
        items: [
          { name: 'Project', description: 'A folder on your computer that you open in Miter.' },
          {
            name: 'Task',
            description: 'One request, its progress, the files it changes, and the follow-ups you send.',
          },
          {
            name: 'Workspace',
            description:
              'Where you switch projects, manage tasks, check files and open the terminal. Open it in the Chrome side panel or in a full tab.',
          },
          {
            name: 'Local helper',
            description:
              'The program installed alongside the extension. It saves files and runs commands, tests and app servers on your computer.',
          },
        ],
      },
      { kind: 'heading', text: 'How they work together' },
      {
        kind: 'steps',
        items: [
          'You give Miter a task. A ChatGPT-backed task opens or links a conversation in your Chrome profile.',
          'ChatGPT proposes a batch, such as reading a file, writing a change or running a check. The extension reads the reply and the local helper validates it.',
          'The helper applies valid changes in your project. When a command needs permission, Miter shows what it would run and asks you to decide.',
          'Miter sends relevant results back to the conversation and repeats the cycle. When the task passes its completion checks, you can review the result and open the app when available.',
        ],
      },
      {
        kind: 'links',
        items: [
          { id: 'getting-started', label: 'Install Miter and run your first task' },
          { id: 'tasks', label: 'See what happens during a task' },
          { id: 'reply-shape', label: 'See the JSON ChatGPT sends back' },
          { id: 'troubleshooting', label: 'Fix a setup or task problem' },
          { id: 'chat-protocol', label: 'Read how Miter and ChatGPT exchange messages' },
        ],
      },
    ],
  },
  {
    id: 'getting-started',
    title: 'Getting started',
    summary: 'Install Miter on macOS, connect the local helper and run a first task in Chrome.',
    blocks: [
      { kind: 'heading', text: 'Install on macOS' },
      {
        kind: 'steps',
        items: [
          'Unzip the Miter installer for your Mac and open Install Miter.command. The bundle includes Node and the helper’s dependencies.',
          'In Chrome, open chrome://extensions and turn on Developer mode. Choose Load unpacked.',
          'Select ~/Library/Application Support/Miter/extension, or the extension folder your installer prints.',
          'Open Miter from Chrome’s Extensions menu. Pin it there if you want a shortcut in your toolbar.',
          'Check for Helper connected. If you want to run a ChatGPT task, use the same Chrome profile where you are signed in to ChatGPT and grant site access when Chrome asks.',
        ],
      },
      { kind: 'heading', text: 'Install or update with npm' },
      {
        kind: 'text',
        text: 'On Apple silicon Macs with Node.js 22 or newer, use this command to install or update Miter.',
      },
      { kind: 'code', language: 'sh', text: 'npx miter-install@latest' },
      {
        kind: 'text',
        text: 'On first install, load the folder the installer prints using the Chrome steps above. After an update, reload Miter’s extension card and reopen the workspace.',
      },
      { kind: 'heading', text: 'Try a reading list' },
      {
        kind: 'steps',
        items: [
          'Choose Create project. Name the folder Reading list, pick a parent folder such as Documents, and leave Starter on Blank project.',
          'Open the project and choose New task. Use the example prompt below or describe your own app.',
          'Select Start task. Watch the task view for a question or a command approval.',
          'When the task completes, open its preview or choose Run. Use Open files to see what Miter made.',
        ],
      },
      {
        kind: 'code',
        language: 'text',
        caption: 'Example first task',
        text: 'Build a reading list for my own use. I want to save book titles, mark books as read, and find them again after a reload. Show an empty state when the list has no books.',
      },
      { kind: 'heading', text: 'Install from the source folder' },
      {
        kind: 'text',
        text: 'With Node.js 26 or newer, run the setup command inside the Miter source folder. It builds and installs a managed copy. Load the folder it prints using the same Chrome steps.',
      },
      { kind: 'code', language: 'sh', text: 'node scripts/setup.mjs' },
      {
        kind: 'links',
        items: [
          { id: 'projects', label: 'Create and open project folders' },
          { id: 'troubleshooting', label: 'Fix a connection or sign-in problem' },
        ],
      },
    ],
  },
  {
    id: 'projects',
    title: 'Projects and folders',
    summary: 'Open an existing folder, start from scratch, or use the SQLite starter.',
    blocks: [
      { kind: 'heading', text: 'Choose a starting point' },
      {
        kind: 'terms',
        items: [
          {
            name: 'Open existing',
            description:
              'Pick the folder that already contains your project. Miter remembers it so you can return from Projects.',
          },
          {
            name: 'Blank project',
            description: 'Choose a new folder name and its parent folder. Start a task to create the files.',
          },
          {
            name: 'Vite + TypeScript + SQLite',
            description:
              'Create a starter with a working notes form, a local API and a database. Choose Run app on the project to install its dependencies and open it.',
          },
        ],
      },
      {
        kind: 'text',
        text: 'A project’s display name can differ from its folder name. Set it in Advanced options when opening or creating the project, or choose Actions → Rename project later.',
      },
      { kind: 'heading', text: 'Switch between projects and tasks' },
      {
        kind: 'text',
        text: 'Use the project and task tabs near the top. If you close a tab, its saved project or task stays in the library. Use Actions → All project tasks or Recently closed to find it again. The status bar can show work still running in closed tabs.',
      },
      {
        kind: 'text',
        text: 'Open Actions → Project context to record conventions that should carry into new requests, such as vocabulary, where tests live or how the app should look.',
      },
      {
        kind: 'links',
        items: [
          { id: 'project-files-and-team', label: 'Work with files and other tasks in the same project' },
          { id: 'previews-and-terminal', label: 'Run a starter or an existing app' },
        ],
      },
    ],
  },
  {
    id: 'tasks',
    title: 'Create and run tasks',
    summary: 'Write a useful request, read the task status, and manage pauses, stops and completions.',
    blocks: [
      { kind: 'heading', text: 'Describe what you want to be able to do' },
      {
        kind: 'text',
        text: 'Name the outcome, the people or files it affects, and one way you can tell that it works. Add constraints that matter, such as keyboard support, an existing design, or data that must survive a reload.',
      },
      {
        kind: 'code',
        language: 'text',
        caption: 'Example change to an existing app',
        text: 'Let staff find reservations by room name. Keep the date filter. If both filters are active, show results that match both. Verify that clearing the room search keeps the selected date.',
      },
      {
        kind: 'text',
        text: 'New task can start immediately or save your request for later. To save only, expand Advanced options and clear Start after creating the task. Before it runs, open the task tab menu and choose Edit task to update the title or details. Titles can still be edited after the task starts.',
      },
      {
        kind: 'list',
        items: [
          'Coding source chooses a ChatGPT conversation or a configured local coding model.',
          'Work in chooses the current folder or a new isolated Git worktree.',
          'Extra completion checks can require a file, expected text in a file, or a registered test command.',
          'Preview Miter’s build brief shows the scope and checks the task will use.',
        ],
      },
      { kind: 'heading', text: 'Read and control progress' },
      {
        kind: 'terms',
        items: [
          {
            name: 'Waiting for ChatGPT',
            description:
              'Miter has sent a message, or is confirming a reply from the linked chat. Check Open chat if the task says the conversation needs attention.',
          },
          {
            name: 'Review command',
            description:
              'A command needs your decision. Open the review and check the working folder and expected changes.',
          },
          {
            name: 'Verifying',
            description:
              'Miter is running checks on the current files. A failure may lead to a repair and another check within the task’s run budget.',
          },
          {
            name: 'Pause and Resume',
            description:
              'Pause keeps the pending plan. Resume continues from saved progress with the remaining budget.',
          },
          {
            name: 'Stop and Continue fresh',
            description:
              'Stop retires the pending plan and keeps completed edits. Continue fresh asks the model to plan again using the current files.',
          },
          {
            name: 'Task complete',
            description:
              'Open Verification details for the evidence, Open files for the changes, and Run when Miter has an app it can serve.',
          },
        ],
      },
      {
        kind: 'text',
        text: 'Use Files and activity or Actions → View full report for details. Use Continue when the task offers more time and turns and you want it to keep working.',
      },
      {
        kind: 'links',
        items: [
          { id: 'follow-ups', label: 'Send a change or steer a running task' },
          { id: 'quality-checks', label: 'Understand the verification evidence' },
        ],
      },
    ],
  },
  {
    id: 'attachments-and-rewrite',
    title: 'Images and Rewrite',
    summary: 'Pick images, paste screenshots, or preview a clearer version of your draft.',
    blocks: [
      { kind: 'heading', text: 'Attach a visual reference' },
      {
        kind: 'steps',
        items: [
          'Choose Attach images in New task or Follow up. To paste a screenshot instead, focus the draft field and press Command+V on Mac or Ctrl+V on Windows or Linux.',
          'Check the thumbnails. Choose Remove next to an image you want to leave out.',
          'Describe the part each image illustrates. For instance, “Use the first screenshot for spacing. In the second, fix the menu that covers the Save button.”',
          'Start or save the task, or submit the follow-up. When the request runs, Miter waits for the attachments to upload to the linked ChatGPT conversation before sending it.',
        ],
      },
      {
        kind: 'text',
        text: 'ChatGPT drafts accept up to four PNG, JPEG, WebP or GIF images, up to 5 MiB each. The images and their draft text are stored in that Chrome profile so you can reopen the draft after a reload. Repeated copies of the same image in one draft appear once.',
      },
      { kind: 'heading', text: 'Review a rewrite' },
      {
        kind: 'steps',
        items: [
          'Type a draft and choose Rewrite. Rewrite with ChatGPT sends the draft text to a separate chat.',
          'Open Rewrite options if you want another style or want to Format on this device.',
          'Read the preview and choose Use rewrite to replace the text, or Keep original to return to your draft. Attachments stay with the task or follow-up.',
          'When the wording is ready, use the regular Start, Create or Send action.',
        ],
      },
    ],
  },
  {
    id: 'follow-ups',
    title: 'Follow-ups and steering',
    summary: 'Build on the same task and decide when a new instruction should take effect.',
    blocks: [
      {
        kind: 'text',
        text: 'Use Follow up under the task when the new request belongs to the same work. The conversation keeps its prior context and Miter continues from the files that already exist.',
      },
      {
        kind: 'terms',
        items: [
          {
            name: 'Send',
            description: 'Save and continue a task that is ready for the next instruction.',
          },
          {
            name: 'Queue follow-up',
            description:
              'Save the request while the task is running. It takes effect when the current work reaches a safe point and the task can continue.',
          },
          {
            name: 'Steer now',
            description:
              'Change direction while a task is running. Miter retires the current pending plan, keeps completed edits and starts planning from your new instruction.',
          },
        ],
      },
      {
        kind: 'code',
        language: 'text',
        caption: 'Example follow-up',
        text: 'Keep the reading list as it is. Add a filter for books I have finished, and keep the existing mark-as-read control.',
      },
      {
        kind: 'text',
        text: 'Use Follow-up history under Actions to see which requests are pending or completed. You can copy a request and remove a queued one. If needed, choose Continue queued follow-ups in the task view.',
      },
      {
        kind: 'text',
        text: 'To ask for a change to a specific section of code, open the file and select the lines you mean. Miter checks that the selection still points to the current file before it applies a follow-up based on that selection.',
      },
      {
        kind: 'links',
        items: [
          { id: 'attachments-and-rewrite', label: 'Add reference images to a follow-up' },
          { id: 'project-files-and-team', label: 'Review the files a follow-up changes' },
        ],
      },
    ],
  },
  {
    id: 'previews-and-terminal',
    title: 'Previews and terminal',
    summary: 'Open your app, restart its server, read logs or run a shell in the project folder.',
    blocks: [
      { kind: 'heading', text: 'Open and manage the app' },
      {
        kind: 'text',
        text: 'Miter opens previews for supported static HTML, Vite and Next.js projects after verification. Choose Run on a completed task to open its preview in a new Chrome tab as soon as the server is ready. A preview is a private page on your computer for trying the app.',
      },
      {
        kind: 'terms',
        items: [
          { name: 'Open app', description: 'Open the running app in Chrome.' },
          { name: 'Restart', description: 'Start the server again and pick up source changes.' },
          { name: 'Stop', description: 'Stop the server and release its local port.' },
          { name: 'Logs', description: 'Read the server output when a preview fails or is slow to start.' },
          {
            name: 'Point to edit',
            description:
              'Click to capture one element and replace any previous captures. Shift-click to add more, up to ten. Captured elements stay outlined on the current page. Option-click (Alt-click) lets you use the app. With the keyboard, Tab to an element and press Enter to capture it or Shift+Enter to add it. Choose Done to review the captures before starting the edit task.',
          },
        ],
      },
      {
        kind: 'text',
        text: 'Run reuses the task’s running server and opens its preview in Chrome. For a stopped session, use Run again in Terminal. Managed servers stop after an idle timeout or when the helper closes. For a supported app with a backend, keep durable server data in the directory Miter supplies as MITER_DATA_DIR so it survives the managed server’s restart.',
      },
      { kind: 'heading', text: 'Run an existing Vite or Next.js app' },
      {
        kind: 'text',
        text: 'Open its folder and enter the launch request below in New task. For a supported build, Miter installs dependencies with pnpm in a private copy, starts the server and opens the browser when it is responding. The launch runs locally.',
      },
      {
        kind: 'code',
        language: 'text',
        text: 'Install dependencies with pnpm, start the dev server, and open the app preview.',
      },
      { kind: 'heading', text: 'Use a shell' },
      {
        kind: 'text',
        text: 'Choose Terminal at the bottom of the workspace, then New shell. Use the session picker to switch between an app, its logs and your shells. A shell runs in the selected project with your operating system permissions. Hide terminal tucks it away, and Close shell ends that session.',
      },
      {
        kind: 'links',
        items: [
          { id: 'commands', label: 'Review commands Miter asks to run' },
          { id: 'settings-and-skills', label: 'Change terminal colors and fonts' },
        ],
      },
    ],
  },
  {
    id: 'commands',
    title: 'Commands and approvals',
    summary: 'Review what a command does, run it once, give a different instruction or run it yourself.',
    blocks: [
      {
        kind: 'text',
        text: 'Use Review setup command when a task asks to install dependencies or set up a project. The dialog shows the exact command, its working folder, why it is needed and what it expects to change. Use Copy to inspect the command more closely.',
      },
      {
        kind: 'terms',
        items: [
          { name: 'Run it', description: 'Approve this setup command once.' },
          {
            name: 'I’ll do it myself',
            description:
              'Open the task’s setup terminal and enter the reviewed command yourself. Miter waits for the result before the task continues.',
          },
          {
            name: 'Do this instead',
            description: 'Tell ChatGPT to take another approach. Enter your instruction in the dialog.',
          },
          { name: 'No', description: 'Decline the setup request.' },
        ],
      },
      {
        kind: 'note',
        text: 'Approved commands have the same permissions as your account. Check the executable, arguments and folder before you approve. The task receives the exit result and limited, redacted output.',
      },
      { kind: 'heading', text: 'Register a test command' },
      {
        kind: 'steps',
        items: [
          'Open Actions → Test commands and add the executable and argument list. For npm test, enter npm as the executable and ["test"] as the arguments.',
          'Choose A registered test command passes in the next task’s Advanced options if that suite should be required.',
          'If Miter asks to run the registered command, approve or reject it. Trusting commands for one imported batch applies only to that batch.',
        ],
      },
      {
        kind: 'text',
        text: 'If you plan to install dependencies yourself, say so in the task. For a request such as “I’ll run pnpm install,” Miter opens the setup review once the project manifest is ready.',
      },
    ],
  },
  {
    id: 'quality-checks',
    title: 'Checks and accessibility',
    summary: 'See what Miter verifies, how it repairs failures, and how to record a workflow of your own.',
    blocks: [
      {
        kind: 'text',
        text: 'A model reply can propose that a task is finished. Miter runs the applicable checks before showing a verified result. Open Verification details to see what it checked and what happened.',
      },
      { kind: 'heading', text: 'What gets checked' },
      {
        kind: 'terms',
        items: [
          {
            name: 'Source and domain tests',
            description:
              'Miter checks the files and runs eligible standalone Node tests against a read-only source copy with temporary test data. A registered test command can cover an existing test suite.',
          },
          {
            name: 'Browser journeys',
            description:
              'For supported web apps, Miter exercises declared user flows in an isolated Chrome profile at desktop and mobile sizes. It checks visible results, keyboard focus, accessibility rules, layout, runtime errors and persistence when configured.',
          },
          {
            name: 'Lighthouse',
            description:
              'After browser journeys pass, Miter measures the verified snapshot at both sizes. By default, every scored category must reach 100. Failed checks go back to the task for repair within its budget.',
          },
        ],
      },
      {
        kind: 'text',
        text: 'For developers, miter.quality.json names files and describes observable journeys. A supported miter.backend.json also lets Miter test a saved value through the app’s API with disposable data. The reports cover the tested snapshot, viewports and journeys. Accessibility evaluation with users and assistive technology covers more than an automated score.',
      },
      { kind: 'heading', text: 'Record a workflow you care about' },
      {
        kind: 'steps',
        items: [
          'Open Actions → Workflows and start a recording.',
          'Use the app in the recording window with sample data. For example, add a new book and mark it as read.',
          'Select something the app should show at the end, name the workflow and save it. Enable the restart check when the result should survive a fresh server and browser.',
          'Replay it from Workflows. Miter also reuses saved workflows during verification.',
        ],
      },
      {
        kind: 'links',
        items: [{ id: 'troubleshooting', label: 'Find the cause of a failed check' }],
      },
    ],
  },
  {
    id: 'project-files-and-team',
    title: 'Files, changes and team',
    summary: 'Browse and review files, coordinate tasks, and choose how their edits share a folder.',
    blocks: [
      {
        kind: 'list',
        items: [
          'Open files on a task to browse the project or its worktree. Files and activity shows files the task changed.',
          'Choose Actions → Review file changes to inspect saved edits. Use Actions → Roll back file edits when you need to restore the task’s tracked changes. Later edits can block a restore. Commands, installs and other outside effects require separate cleanup.',
          'Choose Actions → Open folder to find the actual files on your computer.',
        ],
      },
      { kind: 'heading', text: 'Share a folder or isolate the changes' },
      {
        kind: 'text',
        text: 'The default is Current project folder. To keep work apart in Git, choose New isolated Git worktree in New task → Advanced options. Start from a clean, committed Git repository. A worktree gives the task its own checkout and branch so you can inspect and integrate its changes independently.',
      },
      { kind: 'heading', text: 'Coordinate several tasks' },
      {
        kind: 'text',
        text: 'Open Team in the task’s Files and activity area to see other tasks in the project, their status and their branch or shared folder. Use Send update to share a project note. Other tasks receive it on their next model turn.',
      },
      {
        kind: 'text',
        text: 'Give parallel tasks separate responsibilities. For a reading list, one can work on the database while another adjusts the keyboard interactions. Miter checks file versions and may wait for a project lock when local work overlaps.',
      },
    ],
  },
  {
    id: 'settings-and-skills',
    title: 'Settings, skills and shortcuts',
    summary: 'Customize the terminal, choose notifications, and understand the built-in task instructions.',
    blocks: [
      {
        kind: 'terms',
        items: [
          {
            name: 'Terminal appearance',
            description:
              'Open Settings to change terminal colors, fonts and scrollback. The preview lets you see the effect before you return to work.',
          },
          {
            name: 'Task notifications',
            description:
              'Open the bell to see recent task alerts and jump to the matching task. Settings lets you mute the chime or turn on desktop alerts. Chrome may ask for desktop notification permission.',
          },
          {
            name: 'Project context',
            description:
              'Open Actions to add project-specific conventions. This is useful for design choices, naming rules and how the project is tested.',
          },
        ],
      },
      { kind: 'heading', text: 'Built-in skills' },
      {
        kind: 'text',
        text: 'Skills are instructions Miter supplies with tasks. Caveman favors concise writing, No AI Slop guides copy and Ponytail favors readable, focused implementation. Engineering and app-design guidance help the model apply code and UI conventions. The model can read full built-in references when a task needs them.',
      },
      { kind: 'heading', text: 'Keyboard shortcuts' },
      {
        kind: 'list',
        items: [
          'Use Chrome’s extension shortcuts to see or change the assigned Open the Miter side panel shortcut.',
          'Ctrl+Shift+Backquote toggles Terminal in the workspace. Backquote is the key marked ` on a US keyboard.',
          'Alt+W closes the selected task tab. Alt+Shift+T reopens the most recently closed tab.',
          'Ctrl+Enter or Command+Enter submits the Follow up draft when its actions are available.',
        ],
      },
      { kind: 'links', items: [{ id: 'local-models', label: 'Configure an optional local coding model' }] },
    ],
  },
  {
    id: 'local-models',
    title: 'Local coding models',
    summary: 'Use a GGUF model on your computer when you want a local coding source.',
    blocks: [
      {
        kind: 'text',
        text: 'ChatGPT is available through the browser. To run a model on your computer, get a GGUF model file and install the optional inference runtime.',
      },
      {
        kind: 'steps',
        items: [
          'From the Miter source checkout, install the local runtime with the command below. Obtain a coding model in GGUF format and save the file on this computer.',
          'In Miter, open Settings → Advanced options → Local coding model and choose the model file.',
          'Select Auto-detect GPU or CPU only. Context tokens control how much text the model can consider. Output token cap limits the length of a reply. Save model settings.',
          'In New task → Advanced options, set Coding source to Local coding model. Use a short first request so you can check that the model loads and completes a task.',
        ],
      },
      {
        kind: 'code',
        language: 'sh',
        caption: 'Install the optional inference runtime',
        text: 'pnpm models:install',
      },
      {
        kind: 'text',
        text: 'The native helper runs the model in a separate worker process and queues local requests. Local coding tasks take text instructions. Switch to ChatGPT for image attachments.',
      },
      {
        kind: 'links',
        items: [{ id: 'troubleshooting', label: 'Check setup if a model or prerequisite is missing' }],
      },
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    summary:
      'Find help for a disconnected helper, a blocked chat, a failed check or an app that won’t start.',
    blocks: [
      { kind: 'heading', text: 'Miter says the helper is disconnected' },
      {
        kind: 'text',
        text: 'Open Help → Setup & connection and choose Reconnect when offered. If the helper is missing, run the installer again. Compare Extension and Local helper in Build versions. Update both from the same build, then reload Miter and reopen the workspace.',
      },
      { kind: 'heading', text: 'The task is waiting for ChatGPT' },
      {
        kind: 'text',
        text: 'Open the linked chat from the task. Check that you are signed in, that the conversation belongs to this task, and that Chrome granted Miter access. If you have unsent text or files in that composer, move them somewhere safe before resuming.',
      },
      {
        kind: 'text',
        text: 'When a confirmed reply is pending, Miter can reconnect to its saved conversation in the same profile after a Chrome restart. If the task requests attention, follow the action shown in its status. Resume uses saved progress. Use reply reviews an existing reply before applying it. Resend prompt lets you inspect the exact pending prompt and explicitly send it once when Miter offers that option.',
      },
      { kind: 'heading', text: 'A command or check needs attention' },
      {
        kind: 'list',
        items: [
          'Open Review setup command for a pending dependency install. If you chose I’ll do it myself, use Open setup terminal to return to the session.',
          'For a failed check, open Verification details or Actions → View full report. Look for the first failed action, test or browser expectation.',
          'If a local requirement is missing, open Setup & connection → Automatic checks and follow the displayed setup hint. Check again after fixing it.',
        ],
      },
      { kind: 'heading', text: 'The app preview is unavailable' },
      {
        kind: 'text',
        text: 'Select the app in Terminal and inspect Logs. Restart the managed session after editing source files. If you see a module error when opening an HTML file directly, choose Run in Miter so Chrome loads it over the local preview server.',
      },
      {
        kind: 'text',
        text: 'Open Help → Diagnostics for connection and task details. Review any copied log before sharing it.',
      },
      {
        kind: 'links',
        items: [
          { id: 'updates-and-cli', label: 'Check an install or the status of a terminal task' },
          { id: 'quality-checks', label: 'Understand what a verification report covers' },
          { id: 'reply-recovery', label: 'Read the technical guide to reply recovery' },
        ],
      },
    ],
  },
  {
    id: 'privacy-and-data',
    title: 'Privacy and local data',
    summary: 'Know what a ChatGPT task shares, what lives on your computer and what a reset clears.',
    blocks: [
      { kind: 'heading', text: 'What travels with a task' },
      {
        kind: 'text',
        text: 'A ChatGPT task uses your signed-in conversation. It shares the task, its images when attached, relevant project context and results of the work. Review the scope before you start if the folder holds private material.',
      },
      {
        kind: 'text',
        text: 'Miter validates file paths and applies edits inside the project or its worktree. Its file tools exclude sensitive paths such as .env files and private Git configuration. Your approved commands still run with your account’s permissions.',
      },
      { kind: 'heading', text: 'Where data lives' },
      {
        kind: 'terms',
        items: [
          {
            name: 'Project folders',
            description: 'The actual files you edit or generate. Open them from Actions → Open folder.',
          },
          {
            name: 'Helper data',
            description:
              'Project registrations, tasks, history, journals and reports live under ~/.mitter or the MITTER_HOME folder configured for this install.',
          },
          {
            name: 'Chrome profile',
            description:
              'Workspace settings, chat links and image drafts are stored locally in the profile where you use Miter.',
          },
        ],
      },
      { kind: 'heading', text: 'Clear application data' },
      {
        kind: 'note',
        text: 'Settings → Advanced options → Application data → Clear all Miter data permanently removes Miter’s saved tasks, project registrations, image drafts, settings, journals and state backups. It stops running sessions and returns Miter to first-run setup. Keep a separate copy of the records you need before confirming.',
      },
      {
        kind: 'text',
        text: 'Your project folders, worktree files, downloaded model files, shell history and ChatGPT conversations stay where they are. Manage provider conversations in ChatGPT and project files from your operating system or Git.',
      },
    ],
  },
  {
    id: 'updates-and-cli',
    title: 'Updates and terminal commands',
    summary: 'Keep the extension and helper in sync, or start and monitor a task from your terminal.',
    blocks: [
      { kind: 'heading', text: 'Update a managed installation' },
      {
        kind: 'steps',
        items: [
          'Run npx miter-install@latest, open the updated Install Miter.command, or rerun source setup.',
          'Open chrome://extensions in the profile where you use Miter. Reload its extension card. Close and reopen the workspace.',
          'Open Help → Setup & connection → Build versions and check that the helper and extension match.',
        ],
      },
      {
        kind: 'text',
        text: 'If Chrome loads Miter from a source checkout, its Reload button continues using that folder. Build that checkout with pnpm build, then use pnpm register to point Chrome at its matching helper. The unpacked extension is in apps/extension/.output/chrome-mv3.',
      },
      {
        kind: 'text',
        text: 'For install diagnostics, run pnpm run doctor inside the source checkout. It checks registration and installed files. Setup & connection shows the live browser connection.',
      },
      { kind: 'heading', text: 'Start and watch from a terminal' },
      {
        kind: 'text',
        text: 'The macOS installer provides ~/Library/Application Support/Miter/bin/miter. In the source checkout, you can use pnpm miter. Keep Chrome open with Miter enabled, and sign in for ChatGPT tasks. Review command approvals in the extension.',
      },
      {
        kind: 'code',
        language: 'sh',
        caption: 'Run these from the Miter source checkout',
        text: [
          'pnpm miter start --project /absolute/path/to/new-app --create --goal-file ./brief.txt --watch',
          'pnpm miter list',
          'pnpm miter status TASK_ID',
          'pnpm miter watch TASK_ID',
          'pnpm miter preview TASK_ID',
          'pnpm miter resume TASK_ID --watch',
          'pnpm miter stop TASK_ID',
        ].join('\n'),
      },
      {
        kind: 'text',
        text: 'Replace the example paths and IDs with yours. Use --create only when you want a new folder, or --goal with inline text. Ctrl+C ends watching and leaves the task running. To stop the work, use stop. For scripting, --json returns structured results and operation REQUEST_ID shows the receipt for an earlier request.',
      },
    ],
  },
];
