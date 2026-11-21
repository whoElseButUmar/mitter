import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fixture, importBatch, runToBoundary, digest, registerScript } from './test-fixture.mjs';
import { APP_FOUNDATION_CSS } from '../../../../../packages/protocol/src/task-skills/app-design.ts';
import { APP_COMPONENTS_JS } from '../../../../../packages/protocol/src/task-skills/app-components.ts';

const markup = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Record editor</title><meta name="description" content="Edit and validate a record in your local workspace."><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"><link rel="stylesheet" href="foundation.css"></head>
<body class="ui"><main><h1>Records</h1><button class="ui-button" id="open">Open editor</button></main>
<dialog class="ui-dialog" aria-labelledby="title"><header class="ui-dialog-header"><h2 id="title">Edit</h2></header>
<section class="ui-dialog-body ui-scroll" tabindex="0"><label for="name">Name</label><input id="name" class="ui-control"></section>
<footer class="ui-dialog-footer"><button class="ui-button">Save</button></footer></dialog>
<script type="module" src="app.mjs"></script></body></html>`;
const manifest = JSON.stringify({
  version: 1,
  entry: 'index.html',
  styles: ['foundation.css'],
  components: ['components.mjs'],
  tests: ['domain.test.mjs'],
  journeys: [
    {
      name: 'Open and dismiss editor',
      steps: [
        { type: 'click', selector: '#open' },
        { type: 'expect', selector: 'dialog', visible: true },
        { type: 'press', key: 'Escape' },
        { type: 'expect', selector: 'dialog', visible: false },
        { type: 'expect', selector: '#open', focused: true },
      ],
    },
  ],
});
const failedTest = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valid } from './domain.mjs';
test('reject empty and accept named records', () => {
  assert.equal(valid(''), false);
  assert.equal(valid('Ready'), true);
});`;
const badDomain = 'export function valid(value) { return value.length >= 0; }';
const goodDomain = 'export function valid(value) { return value.trim().length > 0; }';
const editorScript =
  "import { createDialog } from './components.mjs';\nconst editor = createDialog(document.querySelector('dialog')); document.querySelector('#open').addEventListener('click', (event) => editor.open(event.currentTarget));";

function write(path, content) {
  return { type: 'write', path, content, expectedHash: 'missing' };
}

function evidence(worker) {
  return worker.observations
    .map((raw) => JSON.parse(raw))
    .filter((value) => value.results)
    .at(-1);
}

test(
  'CLI completion reruns written Node tests after a repair and saves the domain evidence',
  { skip: process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 26 },
  async (context) => {
    const { service, worker, store } = await fixture(context);
    await importBatch(service, worker, [
      write('domain.mjs', badDomain),
      write('domain.test.mjs', failedTest),
      { type: 'finish', summary: 'Verify the validator.' },
    ]);
    await runToBoundary(service, worker);
    assert.equal(worker.state, 'review');
    assert.equal(worker.completion, undefined);
    const failure = evidence(worker).results.find((result) => result.check.name === 'tests');
    assert.equal(failure.ok, false);
    assert.match(failure.detail, /reject empty and accept named records/);
    assert.match(worker.error, /Domain tests: reject empty and accept named records/);

    await importBatch(service, worker, [
      { type: 'write', path: 'domain.mjs', content: goodDomain, expectedHash: digest(badDomain) },
      write('package.json', '{"type":"module","dependencies":{}}'),
      { type: 'finish', summary: 'Verify the repaired validator.' },
    ]);
    await runToBoundary(service, worker);

    assert.equal(worker.state, 'complete', JSON.stringify(evidence(worker)));
    const completion = store.workers()[0].completion;
    assert.equal(completion.verification, 'passed');
    assert.equal(completion.evidence.domain, 'passed');
    for (const category of ['source', 'browser', 'lighthouse']) {
      assert.equal(completion.evidence[category], 'not-run', category);
    }
    const qualityEvents = store.events().filter((event) => event.kind === 'quality');
    assert.equal(qualityEvents.length, 2);
    for (const event of qualityEvents) {
      assert.match(event.message, /test/i);
      assert.doesNotMatch(event.message, /Chrome|Lighthouse|browser/i);
    }
    assert.equal(
      store.events().some((event) => event.kind === 'approval'),
      false,
    );
  },
);

test('a pre-existing Node test does not verify an unrelated edit', async (context) => {
  const { service, worker, store, root } = await fixture(context);
  await writeFile(path.join(root, 'old.test.mjs'), "throw new Error('Unrelated test ran.');");
  await importBatch(service, worker, [
    write('domain.mjs', goodDomain),
    { type: 'finish', summary: 'Changed the validator.' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.completion.verification, 'not-run');
  assert.equal(
    store.events().some((event) => event.kind === 'quality'),
    false,
  );
});

test('projects with declared packages keep their configured verification path', async (context) => {
  const { service, worker, store, root } = await fixture(context);
  await writeFile(path.join(root, 'package.json'), '{"dependencies":{"example":"1.0.0"}}');
  await importBatch(service, worker, [
    write('domain.test.mjs', "throw new Error('Needs installed project dependencies.');"),
    { type: 'finish', summary: 'Added an integration test.' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.completion.verification, 'not-run');
  assert.equal(
    store.events().some((event) => event.kind === 'quality'),
    false,
  );
});

test(
  'web-app completion enforces defaults, returns failures for repair, and runs fresh tests without approvals',
  {
    skip: process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 26,
  },
  async (context) => {
    const { service, worker, store } = await fixture(context);
    worker.checks = [{ type: 'exists', path: 'index.html' }];
    await importBatch(service, worker, [
      write('index.html', markup.replace('id="name" class=', 'id="name" type="date" class=')),
      write('foundation.css', APP_FOUNDATION_CSS),
      write('components.mjs', APP_COMPONENTS_JS),
      write('app.mjs', editorScript),
      write('domain.mjs', badDomain),
      write('domain.test.mjs', failedTest),
      write('miter.quality.json', manifest),
      { type: 'finish', summary: 'Premature completion.' },
    ]);
    await runToBoundary(service, worker);
    assert.equal(worker.state, 'review');
    assert.equal(worker.completion, undefined);
    assert.match(worker.error, /UI components: index\.html/);
    const first = evidence(worker);
    assert.equal(first.ok, false);
    assert.ok(first.results.some((result) => result.check.name === 'skills' && !result.ok));
    assert.ok(first.results.some((result) => result.check.name === 'components' && !result.ok));

    await importBatch(service, worker, [
      { type: 'skill', name: 'app-design' },
      { type: 'skill', name: 'engineering-quality' },
      {
        type: 'write',
        path: 'index.html',
        content: markup,
        expectedHash: digest(markup.replace('id="name" class=', 'id="name" type="date" class=')),
      },
      { type: 'finish', summary: 'Run the quality checks.' },
    ]);
    await runToBoundary(service, worker);
    assert.equal(worker.state, 'review', JSON.stringify(evidence(worker)));
    assert.equal(worker.completion, undefined);
    assert.ok(
      evidence(worker).results.some((result) => result.check.name === 'tests' && !result.ok),
      JSON.stringify(evidence(worker)),
    );

    await importBatch(service, worker, [
      { type: 'write', path: 'domain.mjs', content: goodDomain, expectedHash: digest(badDomain) },
      { type: 'finish', summary: 'Domain boundary fixed and checked.' },
    ]);
    await runToBoundary(service, worker);
    assert.equal(worker.state, 'complete', JSON.stringify(evidence(worker)));
    assert.equal(worker.completion.verification, 'passed');
    assert.equal(worker.completion.evidence.source, 'passed');
    assert.equal(worker.completion.evidence.domain, 'passed');
    assert.equal(worker.completion.evidence.browser, 'passed');
    assert.equal(worker.completion.evidence.lighthouse, 'passed');
    assert.equal(
      store.events().find((event) => event.kind === 'goal')?.message,
      'Finished. Checks passed: source, domain, browser, Lighthouse.',
    );
    assert.ok(evidence(worker).results.every((result) => result.ok));
    assert.ok(evidence(worker).results.some((result) => result.check.name === 'snapshot'));
    assert.equal(worker.pending, undefined);
    assert.equal(worker.autoCommands, false);
    assert.equal(store.events().filter((event) => event.kind === 'approval').length, 0);
    assert.equal(store.events().filter((event) => event.kind === 'quality').length, 2);
  },
);

test('an existing-file check cannot complete a newly written web app without its quality manifest', async (context) => {
  const { service, worker } = await fixture(context);
  worker.checks = [{ type: 'exists', path: 'index.html' }];
  await importBatch(service, worker, [write('index.html', markup), { type: 'finish', summary: 'Done.' }]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'review');
  assert.match(JSON.stringify(evidence(worker)), /miter\.quality\.json/);
  assert.equal(worker.completion, undefined);
});

test(
  'rechecking an unchanged app returns its rendered empty-state defect for repair',
  {
    skip: process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 26,
  },
  async (context) => {
    const { service, worker, root, store } = await fixture(context);
    worker.goal =
      'Recheck the existing Day Pass Desk under Miter’s current default copy rules. Exercise the Needs payment filter after the last unpaid pass is marked paid. Fix any repeated empty-state wording that the browser check finds, keep the initial entry instruction and the printed pass, and open the verified app.';
    const existingFiles = {
      'index.html': markup.replace(
        '</main>',
        `
      <button class="ui-button" id="filter">Needs payment</button>
      <div aria-live="polite"><div class="empty-state"><strong>No day passes yet</strong><span>Enter a member name to create the first pass.</span></div></div></main>`,
      ),
      'foundation.css': APP_FOUNDATION_CSS,
      'components.mjs': APP_COMPONENTS_JS,
      'domain.mjs': goodDomain,
      'domain.test.mjs': failedTest,
      'app.mjs':
        editorScript +
        `
document.querySelector('#filter').addEventListener('click', () => {
  document.querySelector('.empty-state strong').textContent = 'No passes need payment';
  document.querySelector('.empty-state span').textContent = 'All recorded passes have been paid.';
});`,
      'miter.quality.json': JSON.stringify({
        ...JSON.parse(manifest),
        journeys: [
          {
            name: 'Filter passes needing payment',
            steps: [
              { type: 'click', selector: '#filter' },
              { type: 'expect', selector: '.empty-state strong', text: 'No passes need payment' },
            ],
          },
        ],
      }),
    };
    await Promise.all(
      Object.entries(existingFiles).map(([name, content]) => writeFile(path.join(root, name), content)),
    );
    await importBatch(service, worker, [
      { type: 'skill', name: 'app-design' },
      { type: 'skill', name: 'engineering-quality' },
      {
        type: 'finish',
        summary: 'Run the existing app verification and open its preview.',
        openPreview: true,
      },
    ]);
    await runToBoundary(service, worker);
    assert.deepEqual(store.changedFiles(worker.runId), []);
    assert.equal(worker.state, 'review', worker.error);
    assert.equal(worker.completion, undefined);
    const results = evidence(worker).results;
    assert.equal(results.find((item) => item.check.name === 'tests')?.ok, true);
    const browser = results.find((item) => item.check.name === 'browser');
    assert.equal(browser?.ok, false, JSON.stringify(results));
    assert.match(browser.finding, /All recorded passes have been paid/);
    assert.doesNotMatch(browser.detail, /Enter a member name to create the first pass/);
    assert.ok(!results.some((item) => item.check.name === 'dev-server'));
  },
);

test('an approved generator command cannot bypass default gates by writing outside the edit journal', async (context) => {
  const { service, worker, project, root, store } = await fixture(context);
  const profile = await registerScript(
    service,
    project,
    root,
    "require('node:fs').writeFileSync('index.html', '<html><body>Generated app</body></html>');",
  );
  await importBatch(service, worker, [
    { type: 'command', profileId: profile.id },
    { type: 'finish', summary: 'Generated through a command.' },
  ]);
  await runToBoundary(service, worker);
  assert.equal(worker.state, 'awaiting_approval');
  await service.handle('worker.approve', {
    workerId: worker.id,
    token: worker.pending.token,
    approve: true,
    trustRun: false,
  });
  await service.wait(worker.id);
  assert.equal(worker.state, 'review');
  assert.deepEqual(store.changedFiles(worker.runId), []);
  assert.match(JSON.stringify(evidence(worker)), /miter\.quality\.json/);
  assert.equal(worker.completion, undefined);
});
