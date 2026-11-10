import assert from 'node:assert/strict';
import test from 'node:test';
import { worker, bridge, control } from './fixtures.mjs';
import {
  renderRunner,
  renderAttention,
  renderAppearance,
  renderDialogs,
  renderOwnedForms,
  renderProjectForm,
  renderTeamPanel,
} from './render.fixture.tsx';
import { projectSchema } from '../../../../packages/protocol/src/index.ts';

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

test('monitoring takes priority over active work, and resend disappears while a reply arrives', () => {
  const watching = renderRunner(worker({ state: 'executing' }), {
    bridge: bridge({ active: true, monitoring: true, receiving: false }),
  });
  assert.deepEqual(
    buttons(watching).map((button) => button.label),
    ['Resend prompt…', 'Stop', 'Open chat'],
  );
  assert.match(watching, /Watching for reply/);
  const receiving = renderRunner(worker(), {
    bridge: bridge({ monitoring: true, receiving: true }),
  });
  assert.deepEqual(
    buttons(receiving).map((button) => button.label),
    ['Stop', 'Open chat'],
  );
  assert.match(receiving, /Receiving reply…/);
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
  assert.match(html, /status-needs_attention/);
  assert.ok(html.includes('<span class="state-summary">' + reason + '</span>'));
  assert.equal(html.split(reason).length, 2, 'The full reason is rendered once, without shortening.');
  assert.deepEqual(
    buttons(html.slice(runner, editor)).map((button) => button.label),
    ['Resend prompt…', 'Stop', 'Open chat', 'Use reply…', 'Show details', 'Copy diagnostics'],
  );
  assert.match(html.slice(runner, recovery), /Watching for reply/);
  assert.match(html.slice(runner, recovery), /3\/15 turns/);
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
  assert.match(html, /status-working/);
  assert.match(html, /Receiving reply…/);
  assert.deepEqual(
    buttons(html.slice(runner, editor)).map((button) => button.label),
    ['Stop', 'Open chat', 'Show details', 'Copy diagnostics'],
  );
});

test('active bridge and running local workers render Pause instead of a start control', () => {
  assert.deepEqual(labels(worker(), { bridge: bridge({ active: true }) }), ['Pause', 'Stop', 'Open chat']);
  for (const state of ['queued', 'planning', 'waiting_model', 'waiting_lock', 'executing', 'verifying']) {
    assert.deepEqual(labels(worker({ mode: 'local', state })), ['Pause', 'Stop']);
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
  assert.deepEqual(labels(worker({ queue }), { bridge: bridge() }), ['Continue task', 'Stop', 'Open chat']);
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
  assert.match(html, /≥3\/15 turns/);
  assert.match(html, /Known minimum recovered from older task history/);
  assert.match(html, /aria-hidden="true"/);
});

test('appearance rendering preserves the user worktree copy and labeled native inputs', () => {
  const html = renderAppearance();
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /pwd/);
  assert.match(text, /Aa Bb 0123456789 \(appearance preview\)/);
  assert.match(text, /Missing fonts fall back to FiraCode Nerd Font Mono or another monospace font\./);
  assert.match(html, /<label[^>]*>[\s\S]*?<span>Use system fonts<\/span>[\s\S]*?<\/label>/);
  assert.match(html, /type="file" accept="\.ttf,\.otf,\.woff,\.woff2"/);
  assert.match(html, /aria-label="Close dialog"/);
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
    ['', 'Cancel', 'Save context', '', 'Test sound', 'Save', '', 'Cancel', 'Save name'],
  );
});

test('pristine project and team forms keep native required-field submission available without premature errors', () => {
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
  assert.equal([...projectHTML.matchAll(/<input\b[^>]*\brequired\b/g)].length, 2);
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
