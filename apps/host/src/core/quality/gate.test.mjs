import assert from 'node:assert/strict';
import { promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { APP_FOUNDATION_CSS } from '../../../../../packages/protocol/src/task-skills/app-design.ts';
import { ENGINEERING_GUIDANCE } from '../../../../../packages/protocol/src/task-skills/engineering.ts';
import { completionFailureMessage } from '../service/reports.ts';
import { requestsWebVerification, verifyProjectQuality } from './gate.ts';
import { webAppQualityManifestSchema } from './inspect.ts';

const supported = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 26;
test('only app-scoped user verification requests audit an unchanged project', () => {
  for (const request of [
    'Please recheck Day Pass Desk.',
    'Open the app, then verify the Needs payment filter.',
    'Can you run the Lighthouse audit?',
    'Exercise the form and fix any broken app behavior.',
  ]) {
    assert.equal(requestsWebVerification(request, 'day-pass-desk'), true, request);
  }
  for (const request of [
    'Start the dev server and open the app preview.',
    'Review the README for the app.',
    'Review this shell script.',
    'List the files in this project.',
    'Do not test the app. Open the preview.',
    'Write an explanation of how to test the browser.',
  ]) {
    assert.equal(requestsWebVerification(request, 'day-pass-desk'), false, request);
  }
});

const journeys = [
  {
    name: 'Increase the count',
    steps: [
      { type: 'click', selector: '#increase' },
      { type: 'expect', selector: '#count', text: '1' },
    ],
  },
];

async function fixture(context) {
  const temporaryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'miter-web-gate-'));
  const temporary = await fs.realpath(temporaryPath);
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'project');
  const dataDir = path.join(temporary, 'host-data');
  await fs.mkdir(root);
  await fs.mkdir(dataDir);
  const manifest = {
    version: 1,
    entry: 'index.html',
    styles: ['foundation.css'],
    components: ['components.mjs'],
    tests: ['domain.test.mjs'],
    journeys,
  };
  const files = {
    'miter.quality.json': JSON.stringify(manifest),
    'index.html': `<!doctype html><html class="ui" lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Counter</title><link rel="stylesheet" href="foundation.css"></head>
<body><main><h1>Counter</h1><img src="mark.svg" alt="" width="16" height="16">
<button id="increase" class="ui-button">Increase</button><output id="count">0</output></main>
<script type="module" src="app.mjs"></script></body></html>`,
    'foundation.css': APP_FOUNDATION_CSS,
    'app.mjs': `import { mountCounter } from './components.mjs';
mountCounter(document.querySelector('#increase'), document.querySelector('#count'));`,
    'components.mjs': `import { increase } from './domain.mjs';
export function mountCounter(button, output) {
  button.addEventListener('click', () => {
    output.textContent = String(increase(Number(output.textContent), 10));
  });
}`,
    'domain.mjs': `export function increase(current, maximum) {
  if (current >= maximum) {
    return current;
  }
  return current + 1;
}`,
    'domain.test.mjs': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { increase } from './domain.mjs';
test('increase preserves the upper limit', () => {
  assert.equal(increase(0, 10), 1);
  assert.equal(increase(9, 10), 10);
  assert.equal(increase(10, 10), 10);
});`,
    'mark.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#123" d="M0 0h16v16H0z"/></svg>',
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.writeFile(path.join(root, relative), content);
  }
  const controller = new AbortController();
  let testRuns = 0;
  return {
    root,
    manifest,
    controller,
    testRuns: () => testRuns,
    request: {
      root,
      dataDir,
      changedPaths: ['index.html'],
      commandsRan: false,
      skillsRead: ['app-design', 'engineering-quality'],
      copyInstructions: ['Build a counter.'],
      signal: controller.signal,
      beforeTests: () => {
        testRuns += 1;
      },
    },
  };
}

function passingBrowser() {
  return {
    ok: true,
    browserOk: true,
    lighthouseOk: true,
    findings: [],
    scores: ['desktop', 'mobile'].map((device) => ({
      device,
      categories: { performance: 100, accessibility: 100, 'best-practices': 100, seo: 100 },
    })),
    reports: ['browser-quality/run-test/desktop.json', 'browser-quality/run-test/mobile.json'],
  };
}

function resultNamed(results, name) {
  const result = results.find((candidate) => candidate.check.name === name);
  assert.ok(result, 'Missing gate result: ' + name);
  return result;
}

test(
  'Node evidence covers the written suites and rejects a fixture changed during verification',
  { skip: !supported },
  async (context) => {
    const { request } = await fixture(context);
    const root = await fs.mkdtemp(path.join(request.dataDir, 'node-project-'));
    const fixturePath = path.join(root, 'limits.txt');
    const source = `import { readFileSync } from 'node:fs';
import test from 'node:test'; import assert from 'node:assert/strict';
test('reads the fixture', () => assert.equal(readFileSync(new URL('./limits.txt', import.meta.url), 'utf8'), '3'));`;
    await fs.writeFile(fixturePath, '3');
    await fs.writeFile(path.join(root, 'limit.test.mjs'), source);
    await fs.writeFile(
      path.join(root, 'other.test.mjs'),
      "import test from 'node:test'; test('other check', () => {});",
    );
    await fs.writeFile(path.join(root, 'old.test.mjs'), "throw new Error('Unrelated suite');");
    const results = await verifyProjectQuality(
      {
        ...request,
        root,
        changedPaths: ['limit.test.mjs', 'other.test.mjs', 'limit.test.mjs'],
        beforeTests: (scope) => {
          assert.equal(scope, 'node');
          writeFileSync(fixturePath, '4');
        },
      },
      () => assert.fail('Node tests cannot start a browser audit.'),
    );
    assert.equal(resultNamed(results, 'tests').ok, true);
    assert.match(resultNamed(results, 'tests').detail, /2 tests passed/);
    assert.equal(resultNamed(results, 'snapshot').ok, false);
  },
);

test('an incomplete Node source tree cannot run or earn passing evidence', async (context) => {
  const { request, testRuns } = await fixture(context);
  const root = await fs.mkdtemp(path.join(request.dataDir, 'node-project-'));
  await fs.writeFile(path.join(root, 'entry.test.mjs'), "throw new Error('Must not run');");
  const input = { ...request, root, changedPaths: ['entry.test.mjs'] };
  await fs.mkdir(path.join(root, '1/2/3/4/5/6/7/8/9'), { recursive: true });
  await assert.rejects(verifyProjectQuality(input), /snapshot depth limit/);
  await fs.rm(path.join(root, '1'), { recursive: true });
  await fs.symlink(path.join(root, 'entry.test.mjs'), path.join(root, 'linked.mjs'));
  await assert.rejects(verifyProjectQuality(input), /symbolic link/);
  assert.equal(testRuns(), 0);
});

test('the bundled manifest example validates and missing journeys block before any execution', async (context) => {
  const example = ENGINEERING_GUIDANCE.match(/for example (\{.*\}); adapt project-relative/);
  assert.ok(example, 'Engineering guidance must supply its complete manifest example.');
  webAppQualityManifestSchema.parse(JSON.parse(example[1]));

  const options = await fixture(context);
  const { journeys: omitted, ...manifest } = options.manifest;
  assert.equal(omitted.length, 1);
  await fs.writeFile(path.join(options.root, 'miter.quality.json'), JSON.stringify(manifest));
  const results = await verifyProjectQuality(options.request, async () => {
    assert.fail('An invalid manifest must not start the browser runner.');
  });

  assert.equal(options.testRuns(), 0);
  assert.equal(resultNamed(results, 'components').ok, false);
  assert.match(resultNamed(results, 'components').detail, /manifest.invalid/);
  assert.equal(
    results.some((result) => result.check.name === 'browser'),
    false,
  );
});

test(
  'passing completion binds real domain tests and injected browser evidence to the same snapshot',
  { skip: !supported },
  async (context) => {
    const options = await fixture(context);
    let browserRuns = 0;
    const browserEvidence = passingBrowser();
    const results = await verifyProjectQuality(options.request, async (request) => {
      browserRuns += 1;
      assert.equal(options.testRuns(), 1);
      assert.equal(request.signal, options.controller.signal);
      assert.equal(request.dataDir, options.request.dataDir);
      assert.equal(request.entry, 'index.html');
      assert.deepEqual(request.copyInstructions, ['Build a counter.']);
      assert.deepEqual(request.journeys, journeys);
      assert.equal(request.snapshot.assets.get('foundation.css').bytes.toString(), APP_FOUNDATION_CSS);
      assert.ok(request.snapshot.assets.has('mark.svg'));
      assert.equal(request.snapshot.assets.has('domain.test.mjs'), false);
      assert.equal(request.snapshot.assets.has('miter.quality.json'), false);
      return browserEvidence;
    });

    assert.equal(browserRuns, 1);
    assert.deepEqual(
      results.map((result) => result.check.name),
      ['skills', 'components', 'syntax', 'tests', 'browser', 'lighthouse', 'snapshot'],
    );
    assert.ok(
      results.every((result) => result.ok),
      JSON.stringify(results),
    );
    assert.deepEqual(JSON.parse(resultNamed(results, 'browser').detail).reports, browserEvidence.reports);
    assert.deepEqual(JSON.parse(resultNamed(results, 'lighthouse').detail).scores, browserEvidence.scores);
    assert.match(resultNamed(results, 'snapshot').detail, /1 passing tests.*Browser asset SHA-256:/);
  },
);

test(
  'declaring a backend requires persistence evidence from both devices for the same source snapshot',
  { skip: !supported },
  async (context) => {
    const options = await fixture(context);
    await fs.writeFile(
      path.join(options.root, 'miter.backend.json'),
      JSON.stringify({ entry: 'backend.mjs' }),
    );
    const backend = path.join(options.root, 'backend.mjs');
    await fs.writeFile(backend, 'export function handle() { return Response.json([]); }');
    for (const devices of [[], ['desktop'], ['desktop', 'mobile']]) {
      const results = await verifyProjectQuality(options.request, async (request) => {
        assert.ok(request.snapshot.backend.files.has('backend.mjs'));
        assert.equal(request.snapshot.assets.has('backend.mjs'), false);
        return {
          ...passingBrowser(),
          backend: devices.map((device) => ({ device, journey: journeys[0].name })),
        };
      });
      assert.equal(resultNamed(results, 'browser').ok, devices.length === 2);
    }
    const changed = await verifyProjectQuality(options.request, async () => {
      await fs.appendFile(backend, '\n// Changed after the browser read its snapshot.');
      return passingBrowser();
    });
    assert.equal(resultNamed(changed, 'snapshot').ok, false);
  },
);

test(
  'a failed browser journey, Lighthouse audit or runner cannot become passing completion',
  { skip: !supported },
  async (context) => {
    const options = await fixture(context);
    for (const name of ['browser', 'lighthouse']) {
      const findings = ['desktop: user outcome failed'];
      if (name === 'lighthouse') {
        findings[0] = 'desktop Lighthouse: performance: 99/100; required 100.';
      }
      const browserEvidence = { ...passingBrowser(), ok: false, findings };
      browserEvidence[name + 'Ok'] = false;
      const results = await verifyProjectQuality(options.request, async () => browserEvidence);

      assert.equal(resultNamed(results, 'tests').ok, true);
      assert.equal(resultNamed(results, name).ok, false);
      assert.ok(resultNamed(results, name).detail.includes(findings[0]));
      assert.equal(
        results.every((result) => result.ok),
        false,
      );
    }

    const blocked = await verifyProjectQuality(options.request, async () => ({
      ok: false,
      browserOk: false,
      lighthouseOk: false,
      findings: ['desktop / play: wrong turn'],
      scores: [],
      reports: [],
    }));
    assert.equal(resultNamed(blocked, 'browser').finding, 'desktop / play: wrong turn');
    assert.ok(!blocked.some((item) => item.check.name === 'lighthouse'));

    const results = await verifyProjectQuality(options.request, async () => {
      throw new Error('Chrome closed before verification finished.');
    });
    assert.equal(resultNamed(results, 'browser').ok, false);
    assert.match(resultNamed(results, 'browser').detail, /Chrome closed before verification finished/);
    assert.equal(
      results.some((result) => result.check.name === 'snapshot' && result.ok),
      false,
    );
  },
);

test(
  'the repair message keeps distinct browser failures across repeated views within its size limit',
  { skip: !supported },
  async (context) => {
    const { request, manifest } = await fixture(context);
    const journey = 'Counter: add / reload';
    await fs.writeFile(
      path.join(request.root, 'miter.quality.json'),
      JSON.stringify({ ...manifest, journeys: [{ ...manifest.journeys[0], name: journey }] }),
    );
    const copies = [
      'Remove the descriptive header note “Community kitchen inventory”. Keep the brand.',
      'Remove the unrequested promotional eyebrow “INVENTORY” from <p>.',
    ];
    const findings = [];
    for (const device of ['desktop', 'mobile', 'reflow']) {
      for (const state of ['initial', 'step 1', 'step 2']) {
        for (const copy of copies) {
          findings.push(device + ' / ' + journey + ' / ' + state + ': ' + copy);
        }
      }
    }
    const step = 'Step 2 expect #count: ';
    findings.push(
      'desktop / ' + journey + ': ' + step + 'text="2" bounds=3,4,5,6',
      'mobile / ' + journey + ': ' + step + 'text="2" bounds=7,8,9,10',
      'reflow / ' + journey + ': ' + step + 'text="4" bounds=7,8,9,10',
      'mobile / baseline: Accessibility color-contrast: Elements must meet contrast thresholds [#counter]',
    );
    const raw = Object.freeze([...findings]);
    const results = await verifyProjectQuality(request, async () => ({
      ...passingBrowser(),
      ok: false,
      browserOk: false,
      scores: [],
      findings: raw,
    }));
    const result = resultNamed(results, 'browser');
    assert.equal(result.ok, false);
    const details = JSON.parse(result.detail).findings;
    assert.equal(details.length, 5);
    assert.match(details[0], /^\(9 occurrences\).*Community kitchen inventory/);
    assert.match(details[1], /^\(9 occurrences\).*INVENTORY/);
    assert.match(details[2], /^\(2 occurrences\).*text="2" bounds=3,4,5,6/);
    assert.match(details[3], /text="4"/);
    const repair = completionFailureMessage(results);
    for (const visible of [
      'Community kitchen inventory',
      'INVENTORY',
      'text="2"',
      'text="4"',
      'color-contrast [#counter]',
    ]) {
      assert.ok(repair.includes(visible), repair);
    }
    assert.ok(repair.length <= 480);
    assert.deepEqual(raw, findings);
  },
);

test(
  'source and linked image changes invalidate otherwise passing browser evidence',
  { skip: !supported },
  async (context) => {
    for (const relative of ['domain.test.mjs', 'mark.svg']) {
      const options = await fixture(context);
      const results = await verifyProjectQuality(options.request, async () => {
        if (relative.endsWith('.svg')) {
          await fs.writeFile(path.join(options.root, relative), '<svg xmlns="http://www.w3.org/2000/svg"/>');
        } else {
          await fs.appendFile(path.join(options.root, relative), '\n// Changed after the domain run.\n');
        }
        return passingBrowser();
      });

      assert.equal(resultNamed(results, 'tests').ok, true);
      assert.equal(resultNamed(results, 'browser').ok, true);
      assert.equal(resultNamed(results, 'lighthouse').ok, true);
      assert.equal(resultNamed(results, 'snapshot').ok, false, relative);
      if (relative.endsWith('.svg')) {
        assert.match(resultNamed(results, 'snapshot').detail, /Linked browser assets changed/);
      } else {
        assert.match(resultNamed(results, 'snapshot').detail, /Source changed during verification/);
      }
      assert.equal(
        results.every((result) => result.ok),
        false,
        relative,
      );
    }
  },
);

test(
  'framework gate audits the managed server and binds evidence to the package and project assets',
  { skip: !supported },
  async (context) => {
    const { root, request } = await fixture(context);
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '8.0.0' } }),
    );
    let fingerprint;
    const results = await verifyProjectQuality(
      request,
      async ({ snapshot, devProject, copyInstructions }) => {
        assert.equal(snapshot, undefined);
        assert.deepEqual(copyInstructions, ['Build a counter.']);
        assert.equal(devProject.root, root);
        assert.equal(devProject.framework, 'vite');
        assert.match(devProject.fingerprint, /^[a-f\d]{64}$/);
        fingerprint = devProject.fingerprint;
        return passingBrowser();
      },
    );
    assert.equal(
      results.every((result) => result.ok),
      true,
    );
    const detail = JSON.parse(resultNamed(results, 'browser').detail);
    assert.equal(detail.devServer, 'vite');
    assert.equal(detail.devServerFingerprint, fingerprint);
    const changed = await verifyProjectQuality(request, async () => {
      await fs.writeFile(path.join(root, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      return passingBrowser();
    });
    assert.equal(resultNamed(changed, 'snapshot').ok, false);
  },
);

test(
  'cancellation during browser verification propagates to the owner without completion evidence',
  { skip: !supported },
  async (context) => {
    const options = await fixture(context);
    const reason = new Error('The task owner stopped this run.');
    let browserRuns = 0;

    await assert.rejects(
      verifyProjectQuality(options.request, async ({ signal }) => {
        browserRuns += 1;
        assert.equal(signal, options.controller.signal);
        options.controller.abort(reason);
        return passingBrowser();
      }),
      (error) => error === reason,
    );

    assert.equal(browserRuns, 1);
    assert.equal(options.testRuns(), 1);
  },
);
