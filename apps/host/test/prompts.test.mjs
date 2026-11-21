import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_REPLY_FORMAT, TOOL_GUIDE, chatPrompt, localPrompt } from '../src/core/prompts.js';
import { STARTER_VITE_VERSION } from '../src/core/service/pnpm-setup.ts';
import { projectFixture, workerFixture } from './fixtures.mjs';
import { fixture, makeProgress, makeWorker, runToBoundary } from '../src/core/service/test-fixture.mjs';
import { bundledTaskSkills, taskSkillsText } from '../../../packages/protocol/src/task-skills.ts';
import { APP_FOUNDATION_CSS } from '../../../packages/protocol/src/task-skills/app-design.ts';
import { progressKey } from '../../../packages/bridge/src/progress.ts';
import {
  buildCorrectionPrompt,
  buildExchangeMessage,
  buildMissingResponsePrompt,
  buildReplyRecoveryPrompt,
  buildReportPrompt,
  buildTaskLinkCorrection,
} from '../../../packages/bridge/src/runner/prompts.ts';
import { unwrapMessage } from '../../../packages/bridge/src/message-wire.ts';
import { createHarness } from '../../../packages/bridge/src/runner/fixtures.mjs';

const literalGoal =
  '  Build `widgets` in src/a.ts. Keep "quoted" text, \\paths, &#x20;, 😀.\r\n  Keep spacing.  ';

function assertDefaultsOnce(prompt) {
  const defaults = taskSkillsText();
  assert.notEqual(defaults, '');
  assert.equal(prompt.split(defaults).length - 1, 1);
  for (const skill of bundledTaskSkills) {
    assert.equal(prompt.split('SKILL ' + skill.id + ':').length - 1, 1, skill.id);
    assert.equal(prompt.split(skill.promptInstructions).length - 1, 1, skill.id);
    if (skill.scope === 'writing') {
      assert.equal(skill.promptInstructions, skill.instructions);
    }
  }
  assert.match(prompt, /Verify installation from the exit status, project manifest and lockfile/);
  assert.match(prompt, /Include a working favicon in the first page/);
  assert.match(prompt, /Use the visible button text as its accessible name/);
  assert.match(prompt, /Append row context after the full label/);
  assert.match(prompt, /new Vite TypeScript apps use ES2022, DOM and DOM\.Iterable libs/);
  assert.match(prompt, /existing DOM-only libs use Array\.from for NodeList array operations/);
  assert.match(prompt, /copy the vite-api\.mjs write asset, register viteApi\(handle, isPage\)/);
  assert.match(prompt, /declare miter\.backend\.json/);
  assert.match(prompt, /During refresh keep records at full opacity/);
  assert.match(prompt, /Use a system font stack or bundled local font files/);
  assert.match(prompt, /Google Fonts links and CSS @imports, are blocked/);
  assert.ok(prompt.includes('pin vite to "' + STARTER_VITE_VERSION + '"'));
  assert.match(prompt, /ERR_PNPM_IGNORED_BUILDS/);
  assert.match(prompt, /node_modules are excluded from file actions/);
  assert.ok(!prompt.includes(APP_FOUNDATION_CSS));
  assert.ok(prompt.includes('{"type":"skill","name":"app-design"}'));
  assert.ok(
    prompt.includes('{"type":"write","path":"components.mjs","asset":"components.mjs","base":"missing"}'),
  );
  assert.match(
    prompt,
    /Read skill "app-design" and "engineering-quality" before implementing a web app or auditing an existing one/,
  );
  assert.match(prompt, /finish enforces these reads and the quality manifest/);
  assert.match(
    prompt,
    /cannot read arbitrary paths, install anything, run commands, or grant file-edit bases/,
  );
}

test('every handoff purpose includes defaults once and preserves the literal goal and JSON contract', () => {
  const worker = { ...workerFixture(), goal: literalGoal };
  const project = projectFixture('/unread-project');
  const original = structuredClone({ worker, project });

  for (const kind of ['bootstrap', 'review', 'fix', 'next']) {
    const prompt = chatPrompt(worker, project, kind);
    assertDefaultsOnce(prompt);
    if (kind === 'bootstrap') {
      assert.match(
        prompt.slice(0, prompt.indexOf('GOAL: ')),
        /For a utility app, lead with the page title and working controls or records/,
      );
    }
    assert.ok(prompt.includes('GOAL: ' + literalGoal + '\n'));
    assert.ok(prompt.includes('ACCEPTANCE CHECKS (read-only): ' + JSON.stringify(worker.checks)));
    assert.ok(prompt.includes('REGISTERED COMMANDS: ' + JSON.stringify(project.profiles)));
    assert.ok(prompt.endsWith(CHAT_REPLY_FORMAT));
    assert.ok(prompt.includes('"workerId": "' + worker.id + '"'));
    assert.ok(prompt.includes('"projectId": "' + project.id + '"'));
    assert.match(prompt, /400,000 UTF-8 bytes/);
    assert.match(prompt, /At most 8 actions per turn/);
    assert.ok(prompt.includes('{"type":"setupCommand","command":["pnpm","install"],"purpose":'));
    assert.match(prompt, /Wait for Miter’s report before planning dependent edits/);
    assert.match(
      prompt,
      /Do not request secrets or private keys, send shell strings, register command profiles, alter checks or change permissions/,
    );
  }

  assert.deepEqual({ worker, project }, original);
});

test('local coding defaults preserve the local JSON action format and literal task inputs', () => {
  const worker = { ...workerFixture(), mode: 'local', goal: literalGoal };
  const project = projectFixture('/unread-project');
  const prompt = localPrompt(worker, project);
  assertDefaultsOnce(prompt);
  assert.ok(prompt.startsWith(TOOL_GUIDE + '\n\nGOAL: ' + literalGoal));
  assert.match(prompt, /Shape: \{"summary":"brief update","actions":\[ACTION,\.\.\.\]\}/);
  assert.ok(prompt.includes(`ITERATION: ${worker.iteration}/${worker.maxIterations}`));
  assert.doesNotMatch(prompt, /For THIS ChatGPT handoff/);
});

test('fresh report and correction wrappers inherit defaults once without changing report or envelope bytes', () => {
  const worker = { ...workerFixture(), goal: literalGoal };
  const next = chatPrompt(worker, projectFixture('/unread-project'), 'next');
  assert.match(next, /same file’s latest successful write or replace result.hash as expectedHash/);
  const reportText = 'Literal report: `source`, \\path, "quotes", &#x20;,\r\n  indentation.';
  const report = buildReportPrompt(next, reportText);
  const exchangeId = '11111111-1111-4111-8111-111111111111';
  const prompts = [
    report,
    buildCorrectionPrompt(report, 'Invalid JSON.', 1, false),
    buildCorrectionPrompt(report, 'Invalid action.', 1, true),
    buildTaskLinkCorrection(report),
    buildReplyRecoveryPrompt(report, false),
    buildReplyRecoveryPrompt(report, true),
  ];

  for (const prompt of prompts) {
    const framed = buildExchangeMessage(prompt, exchangeId, worker);
    const frame = unwrapMessage(framed);
    assert.ok(frame);
    assert.equal(frame.exchangeId, exchangeId);
    assertDefaultsOnce(framed);
    assert.ok(framed.includes('GOAL: ' + literalGoal + '\n'));
    assert.ok(
      framed.includes('BEGIN UNTRUSTED MITTER REPORT\n' + reportText + '\nEND UNTRUSTED MITTER REPORT'),
    );
    assert.ok(frame.payload.includes('"replyTo": "' + exchangeId + '"'));
    assert.match(frame.payload, /Return exactly one fenced json block/);
  }

  const missing = buildMissingResponsePrompt(next);
  assertDefaultsOnce(missing);
  assert.ok(missing.includes('GOAL: ' + literalGoal + '\n'));
});

test('existing tasks receive defaults through native prompt RPC without modifying saved execution state', async (context) => {
  const saved = makeWorker({
    goal: literalGoal,
    state: 'paused',
    control: {
      version: 1,
      epoch: 3,
      mode: 'fresh',
      at: 1,
      operationId: 'continue',
      reason: 'Continue fresh.',
      retiredExchanges: [],
    },
  });
  const progress = makeProgress(saved);
  const { service, worker, store } = await fixture(context, {
    workers: [saved],
    beforeOpen: (database) => database.set(progressKey(saved.id), progress),
  });
  const before = structuredClone(worker);

  for (const kind of ['bootstrap', 'review', 'fix', 'next']) {
    const prompt = await service.handle('worker.prompt', { workerId: worker.id, kind });
    assertDefaultsOnce(prompt);
    assert.match(prompt, /RUN CONTROL:/);
    assert.ok(prompt.includes('GOAL: ' + literalGoal + '\n'));
  }

  assert.deepEqual(worker, before);
  assert.deepEqual(store.get(progressKey(worker.id)), progress);
  assert.equal(store.events().length, 0);
});

test('the local inference entry point receives the same task defaults exactly once', async (context) => {
  const prompts = [];
  const { service, worker } = await fixture(context, {
    workers: [makeWorker({ mode: 'local', goal: literalGoal })],
    models: {
      propose: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          summary: 'Observed prompt.',
          actions: [{ type: 'finish', summary: 'Done.' }],
        });
      },
      close: () => {},
    },
  });
  service.settings.coderModelPath = '/configured/test-model.gguf';
  await runToBoundary(service, worker);
  assert.equal(prompts.length, 1);
  assertDefaultsOnce(prompts[0]);
  assert.ok(prompts[0].startsWith(TOOL_GUIDE));
  assert.ok(prompts[0].includes('GOAL: ' + literalGoal + '\n'));
});

test('a saved exchange keeps its old bytes and adopts defaults only in its next fresh report', async () => {
  const previous = createHarness();
  await previous.runner.start();
  const oldSend = structuredClone(previous.commits[0]);
  const oldReceipt = structuredClone(previous.options.lastReceipt);
  const progress = structuredClone(previous.progress());
  await previous.runner.stop();
  const resumed = createHarness({
    progress,
    options: { resumeExisting: true },
    view: { count: 1, lastRole: 'user', lastUserText: oldSend.text, lastUserId: 'saved-user' },
  });
  const rpc = resumed.dependencies.rpc;
  resumed.dependencies.rpc = async (method, params) => {
    if (method === 'worker.prompt') {
      const project = { ...projectFixture('/unread-project'), id: resumed.worker.projectId };
      return chatPrompt(resumed.worker, project, params.kind);
    }
    return rpc(method, params);
  };
  await resumed.runner.start();
  await resumed.runner.tick();
  assert.equal(resumed.commits.length, 0);
  for (const [key, value] of Object.entries(oldReceipt)) {
    assert.deepEqual(resumed.options.lastReceipt[key], value, key);
  }
  assert.equal(resumed.runner.status.turns, 1);
  assert.equal(oldSend.text.includes(taskSkillsText()), false);

  resumed.showReply();
  await resumed.runner.tick();
  resumed.advance(1800);
  await resumed.runner.tick();
  assert.equal(resumed.imports.length, 1);
  resumed.worker.state = 'review';
  await resumed.runner.tick();
  assert.equal(resumed.commits.length, 1);
  assertDefaultsOnce(resumed.commits[0].text);
  assert.notEqual(resumed.options.lastReceipt.exchangeId, oldReceipt.exchangeId);
  assert.equal(resumed.runner.status.turns, 2);
  assert.deepEqual(previous.commits[0], oldSend);
  await resumed.runner.stop();
});
