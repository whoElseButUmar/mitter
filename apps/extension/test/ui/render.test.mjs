import assert from 'node:assert/strict';
import test from 'node:test';
import { worker, bridge, control } from './fixtures.mjs';
import {
  renderRunner,
  renderAttention,
  renderTaskState,
  renderAppearance,
  renderDialogs,
  renderOwnedForms,
  renderProjectForm,
  renderTeamPanel,
} from './render.fixture.tsx';
import { projectSchema } from '../../../../packages/protocol/src/index.ts';
import { renderToString } from 'solid-js/web';
import { ProjectHome } from '../../src/views/ProjectHome.tsx';

function buttons(html) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({
    attributes: match[1],
    label: match[2]
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  }));
}

function labels(task, state) {
  return buttons(renderRunner(task, state)).map((button) => button.label);
}

function renderProjectResults(tasks, connected = true) {
  const project = projectSchema.parse({
    id: 'project',
    name: 'Studio',
    root: '/tmp/studio',
    profiles: [],
    revision: 0,
  });
  return renderToString(() =>
    ProjectHome({
      project,
      projects: [project],
      tasks,
      connected,
      createProject() {},
      openProject() {},
      newTask() {},
      chooseProject() {},
      chooseTask() {},
      browseProjects() {},
      browseTasks() {},
    }),
  );
}

test('project handoff features the latest completion in the selected project without duplicating it', () => {
  const complete = {
    version: 1,
    verification: 'passed',
    checked: 5,
    at: 30,
    summary: 'Model summary',
    evidence: {
      source: 'passed',
      domain: 'passed',
      browser: 'passed',
      lighthouse: 'passed',
      detail: 'Verified.',
    },
  };
  const html = renderProjectResults([
    worker({
      id: 'older',
      projectId: 'project',
      name: 'Older result',
      state: 'complete',
      completion: { ...complete, at: 10 },
      createdAt: 100,
    }),
    worker({
      id: 'latest',
      projectId: 'project',
      name: 'Cozy desk',
      state: 'complete',
      completion: complete,
      createdAt: 1,
    }),
    worker({
      id: 'other',
      projectId: 'elsewhere',
      name: 'Different project',
      state: 'complete',
      completion: { ...complete, at: 90 },
    }),
    worker({ id: 'active', projectId: 'project', name: 'Next idea', createdAt: 200 }),
  ]);
  const result = /<section class="project-result"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  assert.ok(result);
  assert.match(result[1], /App ready/);
  assert.match(result[1], /Cozy desk/);
  assert.deepEqual(
    buttons(result[1]).map((button) => button.label),
    ['View result'],
  );
  assert.match(buttons(result[1])[0].attributes, /class="primary"/);
  assert.doesNotMatch(buttons(html).find((button) => button.label === 'New task').attributes, /primary/);
  assert.equal(html.split('Cozy desk').length, 2);
  assert.match(html, /Older result/);
  assert.match(html, /Next idea/);
  assert.doesNotMatch(html, /Different project|Model summary|Verified\./);
});

test('legacy project results use creation time without claiming app readiness and stay navigable offline', () => {
  const html = renderProjectResults(
    [
      worker({ id: 'older', projectId: 'project', name: 'Old result', state: 'complete', createdAt: 1 }),
      worker({ id: 'latest', projectId: 'project', name: 'Legacy result', state: 'complete', createdAt: 3 }),
    ],
    false,
  );
  const result = /<section class="project-result"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  assert.ok(result);
  assert.match(result[1], /Task complete/);
  assert.match(result[1], /Legacy result/);
  assert.doesNotMatch(result[1], /disabled|App ready|Browser checks passed/);
  assert.doesNotMatch(html, /status-complete/);
  assert.equal(html.split('Task complete').length, 3);
  assert.equal(html.split('Legacy result').length, 2);
  assert.match(buttons(html).find((button) => button.label === 'New task').attributes, /disabled/);
});

test('an unfinished project has no result entry and a single result does not leave an empty task list', () => {
  const unfinished = renderProjectResults([worker({ projectId: 'project', name: 'First idea' })]);
  assert.doesNotMatch(unfinished, /project-result|View result/);
  assert.match(unfinished, /First idea/);
  assert.match(buttons(unfinished).find((button) => button.label === 'New task').attributes, /primary/);
  const finished = renderProjectResults([
    worker({ projectId: 'project', name: 'Only result', state: 'complete' }),
  ]);
  assert.match(finished, /View result/);
  assert.doesNotMatch(finished, /aria-label="Saved tasks"/);
});

test('empty projects explain the next action without implying disconnected work can start', () => {
  assert.match(renderProjectResults([]), /Create your first task to build or change something\./);
  const disconnected = renderProjectResults([], false);
  assert.match(disconnected, /Reconnect to start a task in this project\./);
  assert.doesNotMatch(disconnected, /Create your first task/);
});

test('monitoring takes priority over active work, and resend disappears while a reply arrives', () => {
  const watching = renderRunner(worker({ state: 'executing' }), {
    bridge: bridge({ active: true, monitoring: true, receiving: false }),
  });
  assert.deepEqual(
    buttons(watching).map((button) => button.label),
    ['Open chat', 'Use reply…', 'Resend prompt…', 'Stop'],
  );
  assert.doesNotMatch(watching, /Watching for reply|task-turn-counter/);
  const receiving = renderRunner(worker(), {
    bridge: bridge({ monitoring: true, receiving: true }),
  });
  assert.deepEqual(
    buttons(receiving).map((button) => button.label),
    ['Stop'],
  );
  assert.doesNotMatch(receiving, /Receiving reply…|task-turn-counter/);
});

test('shipping task attention retains the complete reason, live semantics, and recovery reading order', () => {
  const reason =
    'The reply could not be confirmed. Check the linked chat before resending; completed actions are kept. '.repeat(
      6,
    ) +
    'https://example.invalid/' +
    'pending-reply-'.repeat(30);
  const html = renderAttention(reason);
  const status = html.search(/\bclass="[^"]*\btask-state\b/);
  const runner = html.indexOf('class="runner-controls"');
  const recovery = html.indexOf('class="bridge-note"');
  const editor = html.indexOf('class="editor-tabs"');

  assert.ok(status >= 0 && status < runner && runner < recovery && recovery < editor);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /<h2 class="task-status-heading">Needs attention<\/h2>/);
  assert.ok(html.includes('<span class="state-summary">' + reason + '</span>'));
  assert.equal(html.split(reason).length, 2, 'The full reason is rendered once, without shortening.');
  assert.deepEqual(
    buttons(html.slice(runner, editor)).map((button) => button.label),
    ['Open chat', 'Use reply…', 'Resend prompt…', 'Stop', 'Open console', 'Copy diagnostics'],
  );
  const technical = html.indexOf('class="task-diagnostics ');
  assert.ok(technical > runner && technical < recovery);
  assert.doesNotMatch(html.slice(runner, technical), /3\/15 turns|Watching for reply/);
  assert.match(html.slice(technical, recovery), /3\/15 turns/);
  assert.match(html, /aria-atomic="true"/);
  assert.match(html, /aria-label="Debug console"/);
});

test('shipping attention keeps a distinct error before controls without duplicating the status reason', () => {
  const reason = 'The reply is delayed. Check the linked chat before resending.';
  const error = 'The task is paused. Check saved progress before repeating an action. '.repeat(4);
  const html = renderAttention(reason, false, error);
  const banner = html.indexOf('class="error-banner"');

  const status = html.search(/\bclass="[^"]*\btask-state\b/);
  assert.ok(status >= 0 && banner > status && banner < html.indexOf('class="runner-controls"'));
  assert.ok(html.includes('<div class="error-banner" role="alert">' + error + '</div>'));
  assert.equal(html.split(reason).length, 2);
  assert.doesNotMatch(renderAttention(reason, false, reason), /class="error-banner"/);
});

test('shipping reply reception retains Stop, chat, diagnostics, and the full status without offering resend', () => {
  const reason = 'Receiving the delayed reply. Completed actions will not be replayed. '.repeat(6);
  const html = renderAttention(reason, true);
  const runner = html.indexOf('class="runner-controls"');
  const editor = html.indexOf('class="editor-tabs"');

  assert.ok(html.includes('<span class="state-summary">' + reason + '</span>'));
  assert.match(html, /<h2 class="task-status-heading">Reading reply<\/h2>/);
  assert.deepEqual(
    buttons(html.slice(runner, editor)).map((button) => button.label),
    ['Stop', 'Open chat', 'Open console', 'Copy diagnostics'],
  );
});

test('active bridge and running local workers render Pause instead of a start control', () => {
  assert.deepEqual(labels(worker(), { bridge: bridge({ active: true }) }), ['Pause', 'Stop']);
  for (const state of ['queued', 'planning', 'waiting_model', 'waiting_lock', 'executing', 'verifying']) {
    assert.deepEqual(labels(worker({ mode: 'local', state })), ['Pause', 'Stop']);
  }
});

test('connecting exposes the linked chat immediately while keeping Pause and Stop', () => {
  const html = renderRunner(worker(), { bridge: bridge({ active: true, phase: 'connecting' }) });
  const controls = buttons(html);
  assert.deepEqual(
    controls.map((button) => button.label),
    ['Open chat', 'Pause', 'Stop'],
  );
  assert.match(controls[0].attributes, /class="primary"/);
  assert.doesNotMatch(html, /Resume task|Resend prompt/);
});

test('known composer readiness failures make Open chat primary and resume explicit', () => {
  for (const code of ['CHAT_NOT_READY', 'SEND_NOT_READY']) {
    const status = bridge({ phase: 'error', errorCode: code });
    const controls = buttons(renderRunner(worker(), { bridge: status }));
    assert.deepEqual(
      controls.map((button) => button.label),
      ['Open chat', 'Resume task', 'Stop'],
    );
    assert.match(controls[0].attributes, /class="primary"/);
    assert.doesNotMatch(controls[1].attributes, /class="primary"/);
    for (const state of [{ busy: true }, { connected: false }]) {
      for (const control of buttons(renderRunner(worker(), { ...state, bridge: status }))) {
        assert.match(control.attributes, /\bdisabled(?:\s|=|$)/);
      }
    }
    assert.deepEqual(labels(worker({ control: control('stopped') }), { bridge: status }), ['Continue fresh']);
    assert.equal(renderRunner(worker({ state: 'complete' }), { bridge: status }), '');
  }
});

test('readiness recovery cannot bypass approvals, queued work, or reply monitoring', () => {
  const status = bridge({ phase: 'error', errorCode: 'CHAT_NOT_READY' });
  const pending = {
    token: 'approval_1',
    fingerprint: 'fingerprint_1',
    revision: 1,
    reason: 'Review this command.',
    action: { type: 'command', profileId: 'test' },
  };
  assert.deepEqual(labels(worker({ state: 'awaiting_approval', pending }), { bridge: status }), ['Stop']);
  const queue = [
    {
      protocol: 'mitter/1',
      id: 'envelope_1',
      workerId: 'worker_1',
      projectId: 'project_1',
      summary: 'Continue work',
      actions: [{ type: 'command', profileId: 'test' }],
    },
  ];
  assert.deepEqual(labels(worker({ queue }), { bridge: status }), ['Continue task', 'Stop', 'Open chat']);
  assert.deepEqual(labels(worker(), { bridge: { ...status, monitoring: true } }), [
    'Open chat',
    'Use reply…',
    'Resend prompt…',
    'Stop',
  ]);
  assert.deepEqual(labels(worker(), { bridge: { ...status, monitoring: true, receiving: true } }), ['Stop']);
});

test('another task’s bridge cannot offer its connection or recovery controls', () => {
  for (const status of [
    bridge({ workerId: 'other_worker', active: true, phase: 'connecting' }),
    bridge({ workerId: 'other_worker', phase: 'error', errorCode: 'CHAT_NOT_READY' }),
    bridge({ workerId: 'other_worker', phase: 'error', errorCode: 'SEND_NOT_READY', monitoring: true }),
  ]) {
    assert.deepEqual(labels(worker(), { bridge: status, preferReply: true }), ['Run with ChatGPT', 'Stop']);
  }
});

test('pending approval suppresses run/continue controls without hiding Stop', () => {
  const task = worker({
    state: 'awaiting_approval',
    pending: {
      token: 'approval_1',
      fingerprint: 'fingerprint_1',
      revision: 1,
      reason: 'Approval required.',
      action: { type: 'command', profileId: 'test' },
    },
  });
  assert.deepEqual(labels(task), ['Stop']);
});

test('queued envelopes render the correct handoff/local continuation label', () => {
  const queue = [
    {
      protocol: 'mitter/1',
      id: 'envelope_1',
      workerId: 'worker_1',
      projectId: 'project_1',
      summary: 'Continue work',
      actions: [{ type: 'command', profileId: 'test' }],
    },
  ];
  assert.deepEqual(labels(worker({ queue }), { bridge: bridge() }), ['Continue task', 'Stop']);
  assert.deepEqual(labels(worker({ mode: 'local', queue })), ['Continue local work', 'Stop']);
});

test('exhausted handoff offers a bounded extension unless reply recovery takes priority', () => {
  const exhausted = bridge({ errorCode: 'TURN_LIMIT', turns: 15 });
  const html = renderRunner(worker(), { bridge: exhausted });
  assert.deepEqual(
    buttons(html).map((button) => button.label),
    ['Continue · +15 turns', 'Stop', 'Open chat'],
  );
  assert.match(html, /Authorize 15 more turns and 30 more active minutes/);
  assert.deepEqual(labels(worker(), { bridge: exhausted, preferReply: true }), [
    'Use reply…',
    'Stop',
    'Open chat',
  ]);
});

test('handoff labels preserve initial/resume/recovery/fresh/busy priorities', () => {
  assert.deepEqual(labels(worker()), ['Run with ChatGPT', 'Stop']);
  assert.deepEqual(labels(worker({ state: 'paused' })), ['Resume task', 'Stop']);
  assert.deepEqual(labels(worker(), { preferReply: true, busy: true }), ['Use reply…', 'Stop']);
  assert.deepEqual(labels(worker(), { busy: true }), ['Connecting…', 'Stop']);
  assert.deepEqual(
    labels(worker({ control: control('stopped') }), {
      preferReply: true,
      busy: true,
    }),
    ['Continue fresh'],
  );
  assert.deepEqual(labels(worker({ control: control('fresh') })), ['Continue fresh', 'Stop']);
});

test('local fresh continuation is distinct from normal local run', () => {
  assert.deepEqual(labels(worker({ mode: 'local' })), ['Run locally', 'Stop']);
  assert.deepEqual(labels(worker({ mode: 'local', control: control('stopped') })), ['Continue fresh']);
});

test('terminal worker states and human acceptance suppress the entire control section', () => {
  for (const state of ['complete', 'cancelled']) {
    assert.equal(renderRunner(worker({ state }), { bridge: bridge({ active: true }) }), '');
  }
  assert.equal(renderRunner(worker({ humanAcceptanceReady: true })), '');
});

test('disconnected or busy views disable start and Stop controls, retaining native buttons', () => {
  for (const state of [{ connected: false }, { busy: true }]) {
    const rendered = buttons(renderRunner(worker(), state));
    assert.equal(rendered.length, 2);
    for (const button of rendered) {
      assert.match(button.attributes, /\bdisabled(?:\s|=|$)/);
    }
  }
  const html = renderRunner(worker(), { bridge: bridge({ lowerBound: true }) });
  assert.doesNotMatch(html, /task-turn-counter/);
  const details = renderTaskState('running', true);
  assert.match(details, /≥3\/15 turns/);
  assert.match(details, /Known minimum; older sends may be unrecorded/);
  assert.match(html, /aria-hidden="true"/);
});

test('task stages keep output and technical information in closed disclosures', () => {
  for (const [scenario, heading] of [
    ['running', 'Updating project'],
    ['checking', 'Checking results'],
    ['approval', 'Approval needed'],
    ['ready', 'App ready'],
    ['unverified', 'Task complete'],
  ]) {
    const html = renderTaskState(scenario);
    assert.ok(html.includes('<h2 class="task-status-heading">' + heading + '</h2>'));
    assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
    for (const className of ['task-output', 'task-diagnostics']) {
      const disclosure = html.match(new RegExp('<details([^>]*class="' + className + '[^>]*)>'));
      assert.ok(disclosure, scenario + ' has ' + className);
      assert.doesNotMatch(disclosure[1], /\bopen(?:\s|=|$)/);
    }
    assert.match(html, /Files and activity/);
    assert.match(html, /Technical details/);
    assert.doesNotMatch(html, /status-needs_attention|status-working|stop-square/);
  }
});

test('approval keeps its exact reason and command visible before secondary information', () => {
  const html = renderTaskState('approval');
  const reason = 'Run the registered project test suite.';
  assert.equal(html.split(reason).length, 2);
  const approval = html.indexOf('class="approval"');
  const technical = html.indexOf('class="task-diagnostics ');
  assert.ok(approval >= 0 && approval < technical);
  const review = html.slice(approval, technical);
  assert.match(review, /Review command/);
  assert.match(review, /<pre>[\s\S]*pnpm[\s\S]*test[\s\S]*<\/pre>/);
  assert.ok(buttons(review).some((button) => button.label === 'Reject'));
  assert.ok(buttons(review).some((button) => button.label === 'Approve'));
});

test('setup review shows the exact command, folder, expected effects and four choices', () => {
  const html = renderTaskState('setup-command');
  assert.match(html, /Allow this setup command\?/);
  assert.match(html, /pnpm create vite 'my board'/);
  assert.match(html, /Copy command/);
  assert.match(html, /Create a Vite project\./);
  assert.match(html, /Writes package.json and starter files in my board\./);
  assert.match(html, /\/projects\/My board/);
  for (const label of ['No', 'Do this instead', 'I’ll do it myself', 'Run it']) {
    assert.ok(
      buttons(html).some((button) => button.label === label),
      label,
    );
  }
  assert.doesNotMatch(html, /Trust registered commands/);
  const manual = renderTaskState('manual-setup');
  assert.match(manual, /Open setup terminal/);
  assert.doesNotMatch(manual, /Allow this setup command/);
});

test('appearance rendering preserves the user worktree copy and labeled native inputs', () => {
  const html = renderAppearance();
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /pwd/);
  assert.match(text, /Aa Bb 0123456789/);
  assert.match(text, /Missing fonts fall back to FiraCode Nerd Font Mono or another monospace font\./);
  assert.match(html, /<label[^>]*>[\s\S]*?<span>Use system fonts<\/span>[\s\S]*?<\/label>/);
  assert.match(html, /type="file" accept="\.ttf,\.otf,\.woff,\.woff2"/);
  assert.match(html, /aria-label="Close dialog"/);
});

test('appearance keeps common controls visible and advanced options folded without hiding errors', () => {
  const message = 'Terminal settings could not be saved. Try again.';
  const html = renderAppearance(true, message);
  const advanced = /<details\b([^>]*terminal-appearance-options[^>]*)>([\s\S]*?)<\/details>/.exec(html);
  assert.ok(advanced);
  assert.doesNotMatch(advanced[1], /\bopen(?:\s|=|$)/);
  assert.match(advanced[2], /<summary>[\s\S]*?Advanced options<\/summary>/);
  const primary = html.slice(0, advanced.index);
  for (const label of ['Theme', 'Font', 'Font size']) {
    assert.ok(primary.includes('<span>' + label + '</span>'));
  }
  assert.match(primary, /class="terminal-theme-preview"/);
  for (const label of [
    'Use system fonts',
    'Install font…',
    'Install theme…',
    'Cursor',
    'Line height',
    'Scrollback lines',
    'Reset appearance',
  ]) {
    assert.ok(advanced[2].includes(label), label + ' stays available in Advanced options');
    assert.ok(!primary.includes(label), label + ' stays out of the default view');
  }
  const footer = html.slice(advanced.index + advanced[0].length);
  assert.ok(footer.includes(message));
  assert.match(footer, /role="alert"/);
  assert.match(footer, /Changes save automatically\./);
  assert.deepEqual(
    buttons(footer).map((button) => button.label),
    ['Done'],
  );
});

test('appearance startup disables preference changes without disabling queued file imports or closing', () => {
  const html = renderAppearance(false);
  const selects = [...html.matchAll(/<select\b([^>]*)>/g)];
  const numbers = [...html.matchAll(/<input\b([^>]*\btype="number"[^>]*)>/g)];
  const checkboxes = [...html.matchAll(/<input\b([^>]*\btype="checkbox"[^>]*)>/g)];
  const imports = [...html.matchAll(/<input\b([^>]*\btype="file"[^>]*)>/g)];

  assert.equal(selects.length, 3);
  assert.equal(numbers.length, 3);
  assert.equal(checkboxes.length, 2);
  assert.equal(imports.length, 2);
  for (const control of [...selects, ...numbers, ...checkboxes]) {
    assert.match(control[1], /\bdisabled(?:\s|=|$)/);
  }
  for (const input of imports) {
    assert.doesNotMatch(input[1], /\bdisabled(?:\s|=|$)/);
  }

  const reset = buttons(html).find((button) => button.label === 'Reset appearance');
  const done = buttons(html).find((button) => button.label === 'Done');
  assert.ok(reset);
  assert.ok(done);
  assert.match(reset.attributes, /\bdisabled(?:\s|=|$)/);
  assert.doesNotMatch(done.attributes, /\bdisabled(?:\s|=|$)/);

  const readyHTML = renderAppearance();
  for (const control of readyHTML.matchAll(/<(?:input|select)\b([^>]*)>/g)) {
    assert.doesNotMatch(control[1], /\bdisabled(?:\s|=|$)/);
  }
  const readyReset = buttons(readyHTML).find((button) => button.label === 'Reset appearance');
  assert.ok(readyReset);
  assert.doesNotMatch(readyReset.attributes, /\bdisabled(?:\s|=|$)/);
});

test('locally owned settings and rename drafts preserve initial values, native fields, and dialog labels', () => {
  const html = renderOwnedForms(
    projectSchema.parse({
      id: 'project_1',
      name: 'Demo project',
      root: '/project',
      profiles: [],
      revision: 1,
      mission: 'Keep the goal intact.',
      conventions: 'Use native controls.',
    }),
  );
  const dialogs = [...html.matchAll(/<dialog[^>]*aria-labelledby="([^"]+)"[^>]*>([\s\S]*?)<\/dialog>/g)];

  assert.equal(dialogs.length, 3);
  assert.equal(new Set(dialogs.map((dialog) => dialog[1])).size, 3);

  for (const dialog of dialogs) {
    assert.ok(dialog[2].includes('<h2 id="' + dialog[1] + '">'));
  }

  assert.match(html, /<textarea maxlength="4000" rows="3" value="Keep the goal intact\."/);
  assert.match(html, /<textarea maxlength="4000" rows="3" value="Use native controls\."/);
  assert.match(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /<input[^>]*autofocus[^>]*required[^>]*maxlength="60"[^>]*value="Demo project"/);
  assert.deepEqual(
    buttons(html).map((button) => button.label),
    ['', 'Cancel', 'Save context', '', 'Test sound', 'Save changes', '', 'Cancel', 'Save name'],
  );
});

test('pristine project and team forms keep submission available without premature errors', () => {
  const project = projectSchema.parse({
    id: 'project_1',
    name: 'Demo',
    root: '/demo',
    profiles: [],
    revision: 1,
  });
  const projectHTML = renderProjectForm(project);
  const teamHTML = renderTeamPanel();
  const open = buttons(projectHTML).find((button) => button.label === 'Open project');
  const send = buttons(teamHTML).find((button) => button.label === 'Send update');
  assert.ok(open);
  assert.ok(send);
  assert.doesNotMatch(open.attributes, /\bdisabled(?:\s|=|$)/);
  assert.doesNotMatch(send.attributes, /\bdisabled(?:\s|=|$)/);
  assert.equal([...projectHTML.matchAll(/<input\b[^>]*\brequired\b/g)].length, 0);
  const advanced = projectHTML.match(/<details([^>]*)>([\s\S]*?)<\/details>/);
  assert.ok(advanced);
  assert.match(advanced[1], /project-options/);
  assert.doesNotMatch(advanced[1], /\bopen(?:\s|=|$)/);
  assert.match(advanced[2], /Advanced options/);
  assert.match(advanced[2], /name="root"/);
  assert.match(advanced[2], /Display name \(optional\)/);
  assert.match(advanced[2], /name="name"/);
  assert.match(teamHTML, /<textarea\b[^>]*\brequired\b[^>]*maxlength="3000"/);
  assert.doesNotMatch(projectHTML + teamHTML, /aria-invalid="true"|role="alert"/);
});

test('each native dialog is named by its own same-tree heading', () => {
  const html = renderDialogs();
  const dialogs = [...html.matchAll(/<dialog[^>]*aria-labelledby="([^"]+)"[^>]*>([\s\S]*?)<\/dialog>/g)];
  assert.equal(dialogs.length, 2);
  assert.notEqual(dialogs[0][1], dialogs[1][1]);
  for (const dialog of dialogs) {
    assert.ok(dialog[2].includes('<h2 id="' + dialog[1] + '">'));
  }
});
test('verified results group Run and Open files with the outcome and keep full evidence folded', () => {
  const detail =
    'All scored Lighthouse categories reached 100 on desktop and mobile for this snapshot. ' +
    'This does not establish WCAG conformance or deployed performance.';
  const proposal = 'Retry the earlier desktop audit.';
  const html = renderAttention('Idle.', false, '', {
    version: 1,
    verification: 'passed',
    checked: 5,
    at: 1,
    summary: proposal,
    evidence: { source: 'passed', domain: 'passed', browser: 'passed', lighthouse: 'passed', detail },
  });
  const heading = /<div class="task-heading-row">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(heading);
  assert.match(heading[1], /<h1\b/);
  const handoff = html.slice(html.indexOf('class="task-handoff"'), html.indexOf('class="task-details"'));
  assert.match(handoff, /App ready/);
  assert.match(handoff, /aria-label="Run the app"/);
  assert.deepEqual(
    buttons(handoff).map((button) => button.label),
    ['Run', 'Open files'],
  );
  assert.match(html, /<span class="state-summary">Browser checks passed\.<\/span>/);
  assert.equal(html.split(detail).length, 2);
  assert.ok(html.indexOf(detail) < html.indexOf(proposal));
  const evidence = /<details\b([^>]*\bclass="completion-evidence"[^>]*)>([\s\S]*?)<\/details>/.exec(html);
  assert.ok(evidence);
  assert.doesNotMatch(evidence[1], /\bopen(?:\s|=|$)/);
  assert.match(evidence[2], /<summary>[\s\S]*?Verification details<\/summary>/);
  assert.ok(evidence[2].includes(detail));
  assert.ok(evidence[2].includes(proposal));
  assert.match(evidence[2], /Model summary/);
});

test('unverified completion keeps its qualification and does not claim browser checks passed', () => {
  const html = renderAttention('Idle.', false, '', {
    version: 1,
    verification: 'not-run',
    checked: 0,
    at: 1,
    summary: 'Files are ready.',
  });
  assert.match(html, /Completion checks did not run\./);
  assert.ok(buttons(html).some((button) => button.label === 'Open files'));
  assert.doesNotMatch(html, /Browser checks passed|Verification details|aria-label="Run the app"/);
});
