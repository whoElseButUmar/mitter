import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import '../../../../../packages/bridge/src/runner/test-source-loader.mjs';
const { BackendActivity } = await import('./backend-journey.ts');
const { serveSnapshot } = await import('../preview/server.ts');
const { matchesJourneyExpectation, runBrowserJourneys } = await import('./browser-journeys.ts');
const { inspectInterfaceCopy } = await import('./interface-copy.ts');

const executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const available = await fs.access(executable).then(
  () => true,
  () => false,
);

async function fixture(context, markup, script = '', handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'miter-browser-journeys-'));
  const bytes = Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>Journey test</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">
    <style>body{margin:0;padding:20px;font:16px/1.5 system-ui;color:#18222a;background:white}
    *{box-sizing:border-box}button,input{font:inherit;min-height:44px;max-width:100%;margin:4px}
    :focus-visible{outline:3px solid #174b8a;outline-offset:2px}button{color:#18222a;background:#eee}
    dialog{max-width:calc(100vw - 32px)}[hidden]{display:none}</style></head>
    <body><main><h1>Journey test</h1>${markup}</main><script>${script}</script></body></html>`);
  const snapshot = {
    assets: new Map([['index.html', { bytes, mime: 'text/html; charset=utf-8' }]]),
    bytes: bytes.length,
  };
  const activity = new BackendActivity();
  if (handler) {
    snapshot.backend = { entry: 'backend.mjs', files: new Map([['backend.mjs', handler]]) };
  }
  const server = await serveSnapshot(
    snapshot,
    'miter-' + randomBytes(12).toString('hex') + '.localhost',
    randomBytes(12).toString('hex'),
    { dataDir: path.join(directory, 'audit-data'), ephemeral: true, onBackendResponse: activity.response },
  );
  return {
    ...(await chromeFixture(context, directory, server)),
    ...(server.resetBackend && { backend: { activity, reset: server.resetBackend } }),
  };
}

async function chromeFixture(context, directory, server) {
  const origin = new URL(server.url);
  const browser = await puppeteer.launch({
    executablePath: executable,
    headless: true,
    ignoreDefaultArgs: ['--disable-popup-blocking'],
    pipe: true,
    userDataDir: path.join(directory, 'profile'),
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--use-mock-keychain',
      '--password-store=basic',
      '--proxy-server=http://127.0.0.1:9',
      '--proxy-bypass-list=<-loopback>;' + origin.host,
    ],
  });
  context.after(async () => {
    const child = browser.process();
    try {
      await browser.close();
    } finally {
      // Chrome's updater can inherit these pipes after the tested browser exits.
      child?.stderr?.destroy();
      child?.stdout?.destroy();
      await server.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  return {
    browser,
    url: server.url,
    reportDirectory: directory,
    signal: new AbortController().signal,
  };
}

test(
  'real Chrome journeys use controls, preserve reload data and isolate each journey',
  { skip: !available, timeout: 120000 },
  async (context) => {
    const options = await fixture(
      context,
      `<section hidden><input class="title" aria-label="Title"><button class="save">Save</button></section>
      <label for="title">Title</label><input id="title" class="title"><button id="save" class="save">Save</button>
      <section class="detail">Customer directory</section><section class="detail" id="saved" role="status"></section>`,
      `const saved=document.querySelector('#saved'); saved.textContent=localStorage.getItem('record') || 'Empty';
    document.querySelector('#save').addEventListener('click',()=>{const value=document.querySelector('#title').value;
    if(!value.trim()){saved.textContent='Enter a title';return;}localStorage.setItem('record',value);saved.textContent=value;});`,
    );
    const result = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Create and reload',
          steps: [
            { type: 'fill', selector: '.title', value: 'First record' },
            { type: 'click', selector: '.save' },
            { type: 'reload' },
            { type: 'expect', selector: '.detail', text: 'First record', visible: true },
          ],
        },
        {
          name: 'Invalid input starts empty',
          steps: [
            { type: 'click', selector: '#save' },
            { type: 'expect', selector: '#saved', text: 'Enter a title' },
            { type: 'expect', selector: '#title', value: '' },
          ],
        },
      ],
    });
    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
    assert.equal(result.journeys, 4);
    assert.equal(result.screenshots.length, 7);
    for (const screenshot of result.screenshots) {
      assert.ok((await fs.stat(screenshot)).size > 1000);
    }
    assert.equal(options.browser.browserContexts().length, 1, 'All temporary contexts close.');
  },
);

test(
  'record assertions distinguish unique fields, duplicate content and explicit selector counts',
  { skip: !available },
  async (t) => {
    const { browser, url } = await fixture(
      t,
      '<section>Repair due Friday</section><section>Customer Ellis</section>',
    );
    const page = await browser.newPage();
    await page.goto(url);
    const expect = (fields) =>
      page.evaluate(matchesJourneyExpectation, { type: 'expect', selector: 'section', ...fields });
    assert.equal(await expect({ text: 'Friday' }), true);
    assert.equal(await expect({ count: 1, text: 'Friday' }), false);
    assert.equal(await expect({ count: 2, text: 'Friday' }), false);
    assert.equal(await expect({ visible: true }), false);
    await page.evaluate(() => {
      document.querySelectorAll('section')[1].textContent = 'Second repair due Friday';
    });
    assert.equal(await expect({ text: 'Friday' }), false);
    assert.equal(await expect({ count: 2, text: 'Friday' }), true);
    await page.evaluate(() => {
      document.querySelector('section').hidden = true;
      document.querySelectorAll('section')[1].textContent = 'Customer Ellis';
    });
    assert.equal(await expect({ text: 'Friday' }), false);
    assert.equal(await expect({ text: 'Friday', visible: false }), true);
  },
);

test(
  'Chrome checks promotional copy in rendered app states and preserves functional text',
  { skip: !available },
  async (t) => {
    const options = await fixture(
      t,
      `<h2>Weekend Packing List</h2><p class="eyebrow">PACKING PROGRESS</p>
    <p class="subtitle">Enter the name on your reservation.</p><p role="status">0 of 2 packed</p>
    <footer>Prices include tax.</footer><p hidden>Plan less. Travel more.</p>
    <ul><li><span>Built for you.</span></li></ul><button id="open">Show overview</button>
    <section id="overview"></section>`,
      `document.querySelector('#open').onclick = () => {
      document.querySelector('#overview').innerHTML =
        '<span class="eyebrow">YOUR NEXT GETAWAY</span>' +
        '<p>Everything you need, <strong>ready to go.</strong></p>' +
        '<footer>A little less to think about. A lot more to enjoy.</footer>' +
        '<p data-tagline>Small moments. Better weekends.</p>' +
        '<h2 class="subtitle">A smarter way to manage your inventory.</h2>';
    };`,
    );
    const findings = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Show overview',
          steps: [
            { type: 'click', selector: '#open' },
            { type: 'expect', selector: '#overview .eyebrow', text: 'YOUR NEXT GETAWAY' },
          ],
        },
      ],
    });
    assert.equal(findings.ok, false);
    const page = await options.browser.newPage();
    try {
      await page.goto(options.url);
      assert.deepEqual(await inspectInterfaceCopy(page), []);
      await page.click('#open');
      const result = await inspectInterfaceCopy(page);
      assert.equal(result.length, 5, result.join('\n'));
      for (const candidate of result) {
        assert.ok(
          findings.findings.some((finding) => finding.includes(candidate)),
          candidate,
        );
      }
      const requested = await inspectInterfaceCopy(page, [
        'Use the exact tagline “Small moments. Better weekends.”',
      ]);
      assert.deepEqual(
        requested,
        result.filter((finding) => !finding.includes('Small moments.')),
      );
    } finally {
      await page.close();
    }
  },
);

test(
  'Chrome detects duplicate visible status labels inside one record after its state changes',
  { skip: !available },
  async (t) => {
    const options = await fixture(
      t,
      `<article class="piece-row" data-piece="1">
        <div class="piece-details"><span>Blue bowl</span><span>by Noor</span></div>
        <div class="piece-actions"><span class="status-label waiting">Waiting</span>
          <button id="fire">Mark as fired</button></div>
      </article>
      <article><span class="status-label">Fired</span></article>
      <article><span class="status-label">Fired</span>
        <span style="position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden">Fired</span></article>
      <article><span class="status-label">Fired</span><button>Fired</button></article>
      <article><span class="piece-name">Fired</span><span class="status">Fired</span></article>
      <div role="row"><div role="gridcell" class="status">Ready</div><div role="gridcell">Ready</div></div>
      <table><caption>Two inspections</caption><thead><tr><th>Glaze</th><th>Surface</th></tr></thead>
        <tbody><tr><td><span class="status">Ready</span></td><td><span class="status">Ready</span></td></tr></tbody></table>
      <article><span class="piece-name">Clay</span><span class="maker">Clay</span></article>`,
      `document.querySelector('#fire').onclick = () => {
        document.querySelector('.piece-actions').innerHTML =
          '<span class="status-label fired">Fired</span><span class="fired-label">Fired</span>';
      };`,
    );
    const page = await options.browser.newPage();
    try {
      await page.goto(options.url);
      assert.deepEqual(await inspectInterfaceCopy(page), []);
      await page.click('#fire');
      const findings = await inspectInterfaceCopy(page, ['Use the status label “Fired”.']);
      assert.equal(findings.length, 1, findings.join('\n'));
      assert.match(findings[0], /repeated.*“Fired”.*record/i);
      assert.deepEqual(await inspectInterfaceCopy(page, ['Show “Fired” twice on each record.']), []);
      await page.evaluate(() => document.querySelector('.fired-label').remove());
      assert.deepEqual(await inspectInterfaceCopy(page), []);
      await page.evaluate(() => {
        document.querySelector('article').innerHTML =
          '<div><span class="badge">Printed</span></div><span>Printed</span>';
      });
      assert.match((await inspectInterfaceCopy(page)).join('\n'), /repeated.*“Printed”/i);
    } finally {
      await page.close();
    }
  },
);

test(
  'decorative page overlines and repeated brand footers fail without removing context or credits',
  { skip: !available },
  async (t) => {
    const options = await fixture(
      t,
      `<header><a href="/">Repair Bench</a><span class="topbar-note">Community repair café</span></header>
      <div><p class="eyebrow">WORKSHOP</p><h1>Repair queue</h1></div>
      <footer>Repair café workshop queue</footer><footer><p>Repair Bench</p></footer>
      <nav aria-label="Breadcrumb"><span class="eyebrow">Workspace</span><h1>Jobs</h1></nav>
      <section aria-labelledby="zone"><p class="eyebrow" id="zone">Workshop</p><h1>Equipment</h1></section>
      <section><p class="eyebrow">MONTRÉAL</p><h1>Appointments</h1></section>
      <section><p class="eyebrow">Workshop</p><h2>Opening hours</h2></section>
      <footer><span role="status">Repair queue</span></footer>
      <footer>© Repair Bench</footer><footer><small class="credits">Repair queue</small></footer>
      <footer><a href="/about">Repair Bench</a></footer><footer>Community repair café</footer>`,
      "document.title = 'Repair Bench';",
    );
    const page = await options.browser.newPage();
    try {
      await page.goto(options.url);
      const lines = (await inspectInterfaceCopy(page)).map((finding) => finding.match(/“([^”]+)”/u)?.[1]);
      assert.deepEqual(lines, ['WORKSHOP', 'Repair café workshop queue', 'Repair Bench']);
      assert.deepEqual(
        await inspectInterfaceCopy(page, [
          'Use the overline “WORKSHOP”. Add the footer text “Repair café workshop queue”. Keep “Repair Bench” in the footer.',
        ]),
        [],
      );
    } finally {
      await page.close();
    }
  },
);

test(
  'ornamental page categories and redundant brand notes are identified by their roles across domains',
  { skip: !available },
  async (t) => {
    const options = await fixture(
      t,
      `
      <header><a class="wordmark" href="/">Pantry Shelf</a><span class="topbar-note">Community kitchen inventory</span></header>
      <section aria-labelledby="pantry"><div><p class="eyebrow">INVENTORY</p><h1 id="pantry">The pantry</h1></div></section>
      <section><h2 id="inventory-title">Ingredients</h2></section>
      <header><a href="/">Star Desk</a><small class="brand-description">Weekly observatory dispatch</small></header>
      <section aria-labelledby="sky"><p data-kicker>Field dispatch</p><h1 id="sky">Tonight’s skies</h1></section>
      <header><a class="brand" href="/">Pantry Shelf</a><span class="topbar-note">North Street Kitchen</span></header>
      <header><a href="/">Teams</a><span class="brand-note" data-tenant>Brown Ridge Inventory</span></header>
      <header><a href="/">Items</a><span class="brand-note" aria-live="polite">Kitchen inventory</span></header>
      <header><a href="/">Stock</a><span class="brand-note">48 ingredients</span></header>
      <header><a href="/">Timing</a><span class="brand-note"><time>Monday</time></span></header>`,
    );
    const page = await options.browser.newPage();
    try {
      await page.goto(options.url);
      const findings = await inspectInterfaceCopy(page);
      assert.deepEqual(
        findings.map((finding) => finding.match(/“([^”]+)”/u)?.[1]),
        ['Community kitchen inventory', 'INVENTORY', 'Weekly observatory dispatch', 'Field dispatch'],
      );
      assert.deepEqual(
        await inspectInterfaceCopy(page, ['Include a brand note.']),
        findings.filter((finding) => finding.includes('eyebrow')),
      );
      assert.deepEqual(
        await inspectInterfaceCopy(page, ['Add category overlines. Include a brand note.']),
        [],
      );
      await page.evaluate(() => document.querySelector('.eyebrow').remove());
      assert.ok(
        (await inspectInterfaceCopy(page)).some((finding) => finding.includes('Community kitchen inventory')),
      );
    } finally {
      await page.close();
    }
  },
);

test(
  'utility screens omit inert title summaries, generic site roles and workflow footers',
  { skip: !available },
  async (t) => {
    const options = await fixture(t, '');
    const page = await options.browser.newPage();
    try {
      for (const [brand, role, heading, intro, action, footer] of [
        [
          'Return Tray',
          'Library desk',
          'Books out',
          'Keep track of every book on loan.',
          'Add loan',
          'Books returned stay in your loan history.',
        ],
        [
          'Northlight',
          'Fleet console',
          'Vehicle inspections',
          'A single place for your fleet records.',
          'Record inspection',
          'Inspections appear in the fleet archive.',
        ],
      ]) {
        await page.setContent(`<title>${brand}</title><meta name="description" content="${role}">
          <main><header><a class="brand" href="#"><span aria-hidden="true">R</span><span>${brand}</span></a><span class="site-label">${role}</span></header>
          <section aria-labelledby="title"><div><div><h1 id="title">${heading}</h1></div></div><div><p>${intro}</p></div></section>
          <section><form><label>Reference<input></label><button>${action}</button></form></section>
          <footer><small>${footer}</small></footer></main>`);
        const findings = await inspectInterfaceCopy(page);
        assert.deepEqual(
          new Set(findings.map((line) => line.match(/“([^”]+)”/u)?.[1])),
          new Set([role, intro, footer]),
        );
        assert.deepEqual(
          await inspectInterfaceCopy(page, ['Include a page introduction, a header label and footer copy.']),
          [],
        );
        await page.evaluate(() => document.querySelector('form').remove());
        assert.deepEqual(
          await inspectInterfaceCopy(page),
          [],
          'Editorial pages keep ordinary explanatory copy.',
        );
      }
      await page.setContent(`<main>
        <header><a href="#">Return Tray</a><span class="tenant-label" data-tenant>Library desk</span></header>
        <header><a href="#">Return Tray</a><span class="site-label">North Street Library</span></header>
        <section><div><h1>Loans</h1></div><p>Scan the barcode inside the cover.</p></section>
        <section><h1>Availability</h1><p>Reservations open 24 hours before pickup.</p></section>
        <section><h1>Preparation</h1><p>Photograph the signed form in good light.</p></section>
        <section><h1>West branch</h1><p>The service counter is closed for repairs.</p></section>
        <section><h1>Requests</h1><p>No pending requests yet.</p></section>
        <section><h1>Brief</h1><p id="summary">Open the intake form in a separate window.</p></section>
        <a href="#summary">Intake form instructions</a>
        <section><h1>Contact</h1><p id="help">Write the name as printed on the envelope.</p></section>
        <section><h1>Queue</h1><p aria-live="polite">Requests appear in your queue.</p></section>
        <form><input aria-describedby="help" aria-label="Return address"><button>Add request</button></form>
        <footer>Requests stay open until the end of the month.</footer><footer>Prices include tax.</footer>
        <footer role="contentinfo"><a href="#summary">Instructions</a></footer>
        <footer>Credits provided by the local library.</footer><footer><output>Requests appear in your queue.</output></footer>
        <footer><small class="credits">Requests remain in the archive.</small></footer></main>`);
      assert.deepEqual(await inspectInterfaceCopy(page), []);
      await page.setContent(
        '<main><h1>Loans</h1><p>Records are stored in this browser.</p><form><input></form></main>',
      );
      const notices = await inspectInterfaceCopy(page, [], true);
      assert.equal(notices.length, 1);
      assert.match(notices[0], /storage label/);
      assert.deepEqual(await inspectInterfaceCopy(page, ['Include a privacy notice.'], true), []);
    } finally {
      await page.close();
    }
  },
);

test(
  'a filtered empty state keeps its action and drops a second claim about the same records and status',
  { skip: !available },
  async (t) => {
    const options = await fixture(
      t,
      '<button id="unpaid">Needs payment</button><div aria-live="polite"><div class="empty-state"><strong>No day passes yet</strong><span>Enter a member name to create the first pass.</span></div></div>',
      `document.querySelector('#unpaid').onclick = () => {
        document.querySelector('.empty-state strong').textContent = 'No passes need payment';
        document.querySelector('.empty-state span').textContent = 'All recorded passes have been paid.';
      };`,
    );
    const page = await options.browser.newPage();
    try {
      await page.goto(options.url);
      assert.deepEqual(await inspectInterfaceCopy(page), []);
      await page.click('#unpaid');
      const secondary = 'All recorded passes have been paid.';
      const findings = await inspectInterfaceCopy(page);
      assert.equal(findings.length, 1);
      assert.ok(findings[0].includes('“' + secondary + '”'));
      assert.deepEqual(await inspectInterfaceCopy(page, ['Use the exact line “' + secondary + '”']), []);
      assert.deepEqual(await inspectInterfaceCopy(page, ['Include empty-state explanations.']), []);
      assert.deepEqual(await inspectInterfaceCopy(page, ['Include brand messaging.']), findings);
      await page.setContent(`<main>
        <div data-empty-state><h2>No unsigned receipts</h2><p>All receipts are signed.</p></div>
        <div class="empty-state"><b>No exhibits await review</b><small>All listed exhibits have been reviewed.</small></div>
        <div class="empty-state"><strong>No matching routes.</strong><p>No matching routes!</p></div>
        <div class="empty-state"><strong>No exhibits await review</strong><p>All exhibits have been returned.</p></div>
        <div class="empty-state"><strong>No overdue bills need payment</strong><p>All recorded bills have been paid.</p></div>
        <div class="empty-state"><strong>No passes need payment</strong><p>All passes have been paid through Friday.</p></div>
        <div class="empty-state"><strong>No passes need payment</strong><p>All refunds have been paid.</p></div>
        <div class="empty-state"><strong>No unpaid invoices</strong><p>Clear the date filter to see older invoices.</p></div>
        <div class="empty-state"><strong>No unpaid invoices</strong><p id="description">All invoices are paid.</p></div>
        <button aria-describedby="description">Payment status</button>
        <div><strong>No unreviewed items</strong><span>All items have been reviewed.</span></div>
      </main>`);
      assert.deepEqual(
        (await inspectInterfaceCopy(page)).map((line) => line.match(/“([^”]+)”/u)?.[1]),
        ['All receipts are signed.', 'All listed exhibits have been reviewed.', 'No matching routes!'],
      );
    } finally {
      await page.close();
    }
  },
);

test(
  'Chrome flags default browser-storage notices while preserving storage settings and save feedback',
  { skip: !available },
  async (t) => {
    const options = await fixture(
      t,
      `
      <footer><span>Register data is saved in this browser on this device.</span><span role="status">Local register</span></footer>
      <p>Your records are stored locally in your browser.</p><p>All data stays on this device.</p>
      <header>Inventory is saved on this device.</header>
      <header><h2>Members</h2><p class="subtitle">Local ledger</p></header>
      <small>Saved on this device</small>
      <div><h2><span>Local workspace</span></h2></div><nav><span>Local board</span></nav>
      <section aria-labelledby="local-list"><span id="local-list">Local list</span></section>
      <p role="status">Unsaved changes</p><p aria-live="polite">Syncing…</p>
      <p role="status">Offline. Changes will sync when you reconnect.</p>
      <p role="alert">Storage is full. Export your records before closing.</p>
      <p>Data is saved locally. Export a backup before clearing this browser.</p>
      <section aria-label="Privacy settings"><p>Your data is stored on this device.</p></section>
      <section><h2>Data storage</h2><p>Records are stored in this browser.</p></section>
      <button id="save">Save</button><output id="feedback"></output><p id="receipt"></p>`,
      "document.getElementById('save').onclick = () => { document.getElementById('feedback').textContent = 'Saved locally'; document.getElementById('receipt').textContent = 'Saved on this device'; };",
    );
    const page = await options.browser.newPage();
    try {
      await page.goto(options.url);
      const expected = [
        'Register data is saved in this browser on this device.',
        'Local register',
        'Your records are stored locally in your browser.',
        'All data stays on this device.',
        'Inventory is saved on this device.',
        'Local ledger',
        'Saved on this device',
      ];
      const instructions = ['Persist records locally in the browser.'];
      const findings = await inspectInterfaceCopy(page, instructions, true);
      assert.deepEqual(
        findings.map((finding) => finding.match(/“([^”]+)”/u)?.[1]),
        expected,
      );
      assert.deepEqual(await inspectInterfaceCopy(page, ['Include a privacy notice.'], true), []);
      assert.deepEqual(
        await inspectInterfaceCopy(page, ['Keep “Local register” visible.'], true),
        findings.filter((finding) => !finding.includes('Local register')),
      );
      await page.click('#save');
      assert.ok(
        !(await inspectInterfaceCopy(page, instructions, false)).some((finding) =>
          /Saved locally|Saved on this device/.test(finding),
        ),
      );
      await page.evaluate(() => {
        const heading = document.querySelector('h1');
        heading.textContent = 'Privacy settings';
      });
      assert.deepEqual(await inspectInterfaceCopy(page, instructions, true), []);
    } finally {
      await page.close();
    }
  },
);

test(
  'heading copy must add information beyond the rendered controls and empty state',
  { skip: !available },
  async (t) => {
    const options = await fixture(
      t,
      `
    <header aria-describedby="overview"><div><h1>Gym Membership Desk</h1></div><p id="overview">Member register and payments</p></header>
    <section><div><h2>Member register</h2><p>Search members and manage payments.</p></div>
      <input aria-label="Search members"><button>Record payment</button></section>
    <section><div><h2>Membership card</h2><p>Select a member to view their card.</p></div>
      <div><p>Choose a member from the register.</p></div><button>Print card</button></section>
    <section><h2>Tool desk</h2><small>Track loans and manage returns.</small>
      <button>New loan</button><button>Record return</button></section>
    <section><h2>Pickup</h2><p>Choose a date to view the schedule.</p><button>Schedule</button></section>
    <section><h2>Schedule</h2><div><p>Choose a date to view the schedule.</p></div><button>Calendar</button></section>
    <section><h2>Returns</h2><p>Returns after closing are recorded the next day.</p><button>Record return</button></section>
    <section><h2>Member lookup</h2><p id="how">Search by member name and badge number.</p><input aria-describedby="how"></section>
    <section><h2>Counter</h2><p role="status">Loans and returns</p><button>Loans</button><button>Returns</button></section>
    <section><h2>Guestbook</h2><p>Review members and search loans.</p><button>Sign in</button></section>`,
    );
    const page = await options.browser.newPage();
    try {
      await page.goto(options.url);
      const findings = await inspectInterfaceCopy(page);
      const lines = [
        'Member register and payments',
        'Search members and manage payments.',
        'Select a member to view their card.',
        'Track loans and manage returns.',
      ];
      assert.deepEqual(
        findings.map((finding) => finding.match(/“([^”]+)”/u)?.[1]),
        lines,
      );
      assert.deepEqual(await inspectInterfaceCopy(page, ['Use a short description under each heading.']), []);
      assert.deepEqual(
        await inspectInterfaceCopy(page, ['Include “Member register and payments” under the title.']),
        findings.slice(1),
      );
      await page.evaluate(() =>
        Array.from(document.querySelectorAll('p'))
          .find((p) => p.textContent === 'Choose a member from the register.')
          ?.remove(),
      );
      assert.ok(!(await inspectInterfaceCopy(page)).some((finding) => finding.includes('Select a member')));
    } finally {
      await page.close();
    }
  },
);

test('the audit bounds child tabs and disposes its context listeners', { skip: !available }, async (t) => {
  const { observeJourneyPages } = await import('./browser-journey-pages.ts');
  const { DomainRejections } = await import('./domain-rejections.ts');
  const options = await fixture(
    t,
    '<button id="open">Open page</button>',
    "document.querySelector('#open').onclick = () => window.open('?child', '_blank', 'noopener');",
  );
  const context = await options.browser.createBrowserContext();
  const main = await context.newPage();
  await main.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const before = context.listenerCount('targetcreated');
  const entry = new URL(options.url);
  const findings = [];
  const report = (value) => findings.push(value);
  const observers = await observeJourneyPages(
    main,
    entry,
    false,
    false,
    new DomainRejections(entry, false, report),
    report,
  );
  try {
    await main.goto(options.url);
    for (let i = 0; i < 5; i++) {
      const created = new Promise((resolve) => context.once('targetcreated', resolve));
      await main.click('#open');
      await created;
    }
    const widths = [];
    await observers.inspectChildren(async (page) => {
      widths.push(await page.evaluate(() => innerWidth));
      assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation')[0].type), 'navigate');
    });
    assert.deepEqual(widths, [390, 390, 390, 390]);
    assert.equal(findings.length, 1, findings.join('\n'));
    assert.match(findings[0], /more than 4 additional app tabs/);
  } finally {
    await observers.dispose();
    assert.equal(context.listenerCount('targetcreated'), before);
    await context.close();
  }
});

test(
  'a second local app tab can send its result back to the first; unrelated tabs still fail',
  { skip: !available, timeout: 120000 },
  async (context) => {
    const options = await fixture(
      context,
      '<button id="join">Open player O</button><button id="other">Open unrelated tab</button><p id="status"></p>',
      `const status = document.querySelector('#status');
      if (location.search === '?player=O') {
        status.textContent = 'Player O ready';
        if (!sessionStorage.getItem('joined')) {
          sessionStorage.setItem('joined', 'yes');
          location.reload();
        } else {
          localStorage.setItem('player', 'Player O joined');
        }
      }
      addEventListener('storage', event => { if(event.key === 'player') status.textContent = event.newValue; });
      document.querySelector('#join').onclick = () => window.open('?player=O', '_blank', 'noopener');
      document.querySelector('#other').onclick = () => window.open('about:blank', '_blank');`,
    );
    const result = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Join from player O',
          steps: [
            { type: 'click', selector: '#join' },
            { type: 'expect', selector: '#status', text: 'Player O joined' },
          ],
        },
        {
          name: 'Unrelated tab',
          steps: [
            { type: 'click', selector: '#other' },
            { type: 'expect', selector: '#status', count: 1 },
          ],
        },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.journeys, 4, result.findings.join('\n'));
    assert.ok(
      result.findings.every((finding) => finding.includes('Unrelated tab')),
      result.findings.join('\n'),
    );
    assert.ok(
      result.findings.some((finding) =>
        /outside the preview|point it to a page in this preview/.test(finding),
      ),
    );
    assert.equal(options.browser.browserContexts().length, 1);
  },
);

test(
  'popup startup console errors, exceptions and HTTP failures are recorded on both devices',
  { skip: !available, timeout: 120000 },
  async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'miter-popup-journey-'));
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      let body;
      if (request.url === '/project/player.html') {
        // A valid document forces the audit to detect the HTTP status independently of its markup.
        response.statusCode = 404;
        body =
          '<h1>Player ready</h1><script>console.error("Player startup diagnostic");throw Error("Player startup failed")</script>';
      } else {
        body =
          "<h1>Players</h1><button onclick=\"window.open('player.html', '_blank', 'noopener')\">Open player</button>";
      }
      response.end(`<!doctype html><html lang="en"><title>Players</title><main>${body}</main></html>`);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const options = await chromeFixture(context, directory, {
      url: `http://127.0.0.1:${server.address().port}/project/index.html`,
      close: () => new Promise((resolve) => server.close(resolve)),
    });
    const result = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Open player',
          steps: [
            { type: 'click', selector: 'button' },
            { type: 'expect', selector: 'button', text: 'Open player' },
          ],
        },
      ],
    });
    assert.equal(result.journeys, 2, result.findings.join('\n'));
    for (const device of ['desktop', 'mobile']) {
      const findings = result.findings.filter((item) => item.startsWith(device + ' / Open player:'));
      const report = findings.join('\n');
      assert.match(report, /Console error: Player startup diagnostic/);
      assert.match(report, /JavaScript error[^\n]*Player startup failed/);
      assert.match(report, /App tab navigation returned HTTP 404/);
    }
  },
);

test(
  'full-document link journeys inspect the bootstrapped destination and still reject a settled blank page',
  { skip: !available, timeout: 60000 },
  async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'miter-navigation-journey-'));
    const server = createServer((request, response) => {
      if (request.url === '/project/page.mjs') {
        response.setHeader('Content-Type', 'text/javascript');
        setTimeout(
          () =>
            response.end(
              "if (!location.search) document.querySelector('main').innerHTML = '<h1>Dispatch</h1>'",
            ),
          300,
        );
        return;
      }
      response.setHeader('Content-Type', 'text/html');
      let body = '<main></main><script type="module" src="./page.mjs"></script>';
      if (request.url === '/project/index.html') {
        body =
          '<main><h1>Desk</h1><a id="next" href="dispatch.html">Dispatch</a> <a id="blank" href="dispatch.html?blank">Blank</a></main>';
      }
      response.end(
        '<!doctype html><html lang="en"><head><title>Desk</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"></head><body>' +
          body +
          '</body></html>',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const options = await chromeFixture(context, directory, {
      url: `http://127.0.0.1:${server.address().port}/project/index.html`,
      close: () => new Promise((resolve) => server.close(resolve)),
    });
    const result = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Open dispatch',
          steps: [
            { type: 'click', selector: '#next' },
            { type: 'expect', selector: 'h1', text: 'Dispatch' },
          ],
        },
        {
          name: 'Open blank',
          steps: [
            { type: 'click', selector: '#blank' },
            { type: 'expect', selector: 'main', count: 1 },
          ],
        },
      ],
    });
    for (const device of ['desktop', 'mobile']) {
      const healthy = result.findings.filter((item) => item.startsWith(device + ' / Open dispatch'));
      assert.deepEqual(healthy, []);
      assert.ok(
        result.findings.some(
          (item) => item.includes(device + ' / Open blank') && item.includes('no visible text'),
        ),
      );
    }
  },
);

test(
  'an asynchronous save redirects during inspection without repeating the write or hiding destination defects',
  { skip: !available, timeout: 60000 },
  async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'miter-save-navigation-'));
    let writes = 0;
    let saved;
    const server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/project/api/parcels') {
        writes++;
        response.setHeader('Content-Type', 'application/json');
        saved = response;
        return;
      }
      if (request.url === '/project/inspection-started') {
        setTimeout(() => saved.end(JSON.stringify({ id: 17 })), 30);
        response.end();
        return;
      }
      response.setHeader('Content-Type', 'text/html');
      let content =
        '<h1>Parcel details</h1><section aria-label="Parcel"><h2>Recipient</h2></section><section aria-label="Parcel"><h2>Carrier</h2></section>';
      if (request.url === '/project/index.html') {
        content = `<h1>Receive parcel</h1><button id="save">Save parcel</button><ul>${Array.from({ length: 240 }, (_, index) => '<li>Parcel ' + index + '</li>').join('')}</ul><script>
            document.querySelector('#save').onclick = async () => {
              // Deliver the pending save once the post-click rendered checks begin.
              const innerText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText').get;
              Object.defineProperty(document.body, 'innerText', { configurable: true, get() {
                delete this.innerText;
                fetch('/project/inspection-started');
                return innerText.call(this);
              }});
              const response = await fetch('/project/api/parcels', { method: 'POST' });
              const parcel = await response.json();
              location.assign('/project/parcels/' + parcel.id);
            };
          </script>`;
      }
      response.end(
        '<!doctype html><html lang="en"><title>Parcels</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><main>' +
          content +
          '</main></html>',
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const options = await chromeFixture(context, directory, {
      url: `http://127.0.0.1:${server.address().port}/project/index.html`,
      close: () => new Promise((resolve) => server.close(resolve)),
    });
    const result = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Receive parcel',
          steps: [
            { type: 'click', selector: '#save' },
            { type: 'expect', selector: 'h1', text: 'Parcel details' },
          ],
        },
      ],
    });
    assert.equal(writes, 2, 'Save should run once per device.');
    assert.equal(result.journeys, 2, result.findings.join('\n'));
    for (const device of ['desktop', 'mobile']) {
      assert.ok(
        result.findings.some(
          (item) => item.startsWith(device + ' / Receive parcel') && item.includes('landmark-unique'),
        ),
        result.findings.join('\n'),
      );
    }
  },
);

test(
  'backend journeys require a successful API round trip after clearing browser storage on both devices',
  {
    skip: !available || process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 26,
    timeout: 120000,
  },
  async (context) => {
    const options = await fixture(
      context,
      '<label for="title">Title</label><input id="title"><button id="save">Save</button><p id="saved" role="status"></p>',
      `const saved = document.querySelector('#saved');
      fetch('./api/record').then(r => r.json()).then(value => {saved.textContent = value || sessionStorage.getItem('title') || 'Empty';});
      document.querySelector('#save').addEventListener('click', async () => {
        const value = document.querySelector('#title').value;
        await fetch('./api/record', {method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(value)});
        sessionStorage.setItem('title', value);
        saved.textContent = value;
      });`,
      `import { readFile, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export async function handle(request, {dataDir}) {
        const file = join(dataDir, 'record.json');
        let value = '';
        try { value = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (request.method === 'POST') {
          const next = await request.json();
          if (value === next) return Response.json('Duplicate', {status: 409});
          if (next === 'Client only') return Response.json('Accepted');
          await writeFile(file, JSON.stringify(next));
          return Response.json(next, {status:201});
        }
        return Response.json(value);
      }`,
    );
    const name = 'Record a new title';
    const steps = [
      { type: 'fill', selector: '#title', value: 'Fresh title' },
      { type: 'click', selector: '#save' },
      { type: 'reload' },
      { type: 'expect', selector: '#saved', text: 'Fresh title' },
    ];
    const result = await runBrowserJourneys({ ...options, journeys: [{ name, steps }] });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.backend, [
      { device: 'desktop', journey: name },
      { device: 'mobile', journey: name },
    ]);
    const clientOnly = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name,
          steps: [
            { type: 'fill', selector: '#title', value: 'Client only' },
            { type: 'click', selector: '#save' },
            { type: 'reload' },
            { type: 'expect', selector: '#saved', text: 'Empty' },
          ],
        },
      ],
    });
    assert.equal(clientOnly.journeys, 2, JSON.stringify(clientOnly.findings));
    assert.equal(clientOnly.ok, false);
    assert.deepEqual(clientOnly.backend, []);
  },
);

test(
  'fill replaces prefilled text, custom dates, native dates and numbers and reports clearing',
  { skip: !available, timeout: 120000 },
  async (context) => {
    const options = await fixture(
      context,
      `<style>#native-date:focus-within{outline:3px solid #174b8a;outline-offset:2px}</style>
      <div><label for="title">Title</label><input id="title" value="Existing title"></div>
      <div><label for="date">Checkout</label><input id="date" value="2026-11-12" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"></div>
      <div><label for="native-date">Native date</label><input id="native-date" type="date" value="2026-11-12"></div>
      <div><label for="quantity">Quantity</label><input id="quantity" type="number" value="123"></div>
      <div><label for="notes">Notes</label><textarea id="notes">Existing notes</textarea></div>
      <p id="cleared" role="status">Not cleared</p>`,
      `document.querySelector('#title').addEventListener('input',event=>{
        if(event.target.value===''){document.querySelector('#cleared').textContent='Cleared';}
      });`,
    );
    const result = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Replace existing values',
          steps: [
            { type: 'fill', selector: '#title', value: 'Replacement' },
            { type: 'expect', selector: '#title', value: 'Replacement' },
            { type: 'fill', selector: '#date', value: '2027-03-04' },
            { type: 'expect', selector: '#date', value: '2027-03-04' },
            { type: 'fill', selector: '#native-date', value: '2027-03-04' },
            { type: 'expect', selector: '#native-date', value: '2027-03-04' },
            { type: 'fill', selector: '#quantity', value: '3' },
            { type: 'expect', selector: '#quantity', value: '3' },
            { type: 'fill', selector: '#notes', value: 'Replaced notes' },
            { type: 'expect', selector: '#notes', value: 'Replaced notes' },
            { type: 'fill', selector: '#title', value: '' },
            { type: 'expect', selector: '#title', value: '' },
            { type: 'expect', selector: '#cleared', text: 'Cleared' },
          ],
        },
      ],
    });
    assert.deepEqual(result.findings, []);
    assert.equal(result.journeys, 2);
    assert.equal(options.browser.browserContexts().length, 1);
  },
);

test(
  'fill fails at the interaction when application logic rejects the exact value',
  { skip: !available, timeout: 120000 },
  async (context) => {
    const options = await fixture(
      context,
      '<label for="quantity">Quantity</label><input id="quantity" type="number" value="1"><p id="saved">Unchanged</p>',
      `document.querySelector('#quantity').oninput=event=>{event.target.value='1';};`,
    );
    const result = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Rejected input',
          steps: [
            { type: 'fill', selector: '#quantity', value: '3' },
            { type: 'expect', selector: '#saved', text: 'Unchanged' },
          ],
        },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.journeys, 0);
    assert.ok(
      result.findings.some((value) => value.includes('Step 1 fill #quantity') && value.includes('value="1"')),
    );
    assert.equal(result.screenshots.filter((file) => file.endsWith('-failed.png')).length, 2);
    assert.equal(options.browser.browserContexts().length, 1);
  },
);

test(
  'overflow evidence names absolute descendants that escape static scrollports',
  { skip: !available, timeout: 120000 },
  async (context) => {
    const options = await fixture(
      context,
      `<div id="table-shell" style="overflow:auto;width:100%"><table style="width:700px"><tbody><tr>
      <td style="width:550px">Equipment</td><td><span id="escaped" style="position:absolute;width:1px;height:1px;overflow:hidden">Actions</span></td>
      </tr></tbody></table></div><button id="save">Save</button>`,
    );
    const result = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Click save',
          steps: [
            { type: 'click', selector: '#save' },
            { type: 'expect', selector: '#save', visible: true },
          ],
        },
      ],
    });
    const overflow = result.findings.find((value) =>
      value.startsWith('mobile / baseline / initial: The page overflows'),
    );
    assert.ok(overflow, JSON.stringify(result.findings));
    assert.match(overflow, /#escaped \[left=\d+, right=\d+, position=absolute, offsetParent=body/);
    assert.doesNotMatch(
      overflow,
      /Outside bounds: table /,
      'A clipped wide table is not an escaping element.',
    );
    assert.equal(options.browser.browserContexts().length, 1);
  },
);

test(
  'rendered accessibility and reflow failures cannot pass declared successful assertions',
  { skip: !available, timeout: 120000 },
  async (context) => {
    const options = await fixture(
      context,
      '<div style="width:600px">Overflow content</div><div style="box-shadow:0 2px 8px #777"><button id="unnamed" style="outline:none"></button></div><p id="result">Ready</p>',
      `document.querySelector('#unnamed').addEventListener('click',()=>{document.querySelector('#result').textContent='Done';});`,
    );
    const result = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Click action',
          steps: [
            { type: 'click', selector: '#unnamed' },
            { type: 'expect', selector: '#result', text: 'Done' },
          ],
        },
      ],
    });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((value) => value.includes('button-name')));
    assert.ok(result.findings.some((value) => value.includes('overflows horizontally at 320')));
    assert.ok(
      result.findings.some((value) => value.includes('Keyboard focus needs a visible outline')),
      'A decorative ancestor shadow cannot stand in for a changing focus indicator.',
    );
    assert.equal(result.journeys, 2, 'A successful journey does not hide independent quality failures.');
    assert.equal(options.browser.browserContexts().length, 1);
  },
);

test(
  'modal clipping checks preserve reachable scrolling bodies and reject hidden footers',
  { skip: !available, timeout: 120000 },
  async (context) => {
    const options = await fixture(
      context,
      `<button id="open">Open editor</button><dialog id="editor" aria-labelledby="editor-title" style="padding:0;overflow:hidden">
      <h2 id="editor-title" style="margin:8px">Edit record</h2>
      <div style="height:100px;overflow:auto"><div style="height:300px;padding-top:220px"><button id="reachable">Save record</button></div></div>
      <p id="notice" role="status" style="margin:8px">Ready</p></dialog>
      <button id="open-broken">Open broken editor</button><dialog id="broken" aria-labelledby="broken-title" style="height:120px;overflow:hidden">
      <h2 id="broken-title" tabindex="-1" autofocus>Broken editor</h2><div style="height:240px"></div><button id="clipped">Hidden save</button></dialog>
      <button id="open-focus">Open focus editor</button><dialog id="focus-editor" aria-labelledby="focus-title" style="box-shadow:0 2px 10px #777">
      <h2 id="focus-title" tabindex="-1" autofocus>Focus editor</h2><button id="no-ring" style="outline:none">Save changes</button></dialog>`,
      `const editor=document.querySelector('#editor');document.querySelector('#open').onclick=()=>editor.showModal();
    document.querySelector('#reachable').onclick=()=>document.querySelector('#notice').textContent='Saved';
    document.querySelector('#open-broken').onclick=()=>document.querySelector('#broken').showModal();
    document.querySelector('#open-focus').onclick=()=>document.querySelector('#focus-editor').showModal();`,
    );
    const good = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Scroll in editor',
          steps: [
            { type: 'click', selector: '#open' },
            { type: 'click', selector: '#reachable' },
            { type: 'expect', selector: '#notice', text: 'Saved' },
            { type: 'press', key: 'Escape' },
            { type: 'expect', selector: '#editor', visible: false },
          ],
        },
      ],
    });
    assert.deepEqual(good.findings, []);
    const bad = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Clipped footer',
          steps: [
            { type: 'click', selector: '#open-broken' },
            { type: 'expect', selector: '#broken', visible: true },
          ],
        },
        {
          name: 'Missing dialog focus ring',
          steps: [
            { type: 'click', selector: '#open-focus' },
            { type: 'press', key: 'Tab' },
            { type: 'expect', selector: '#no-ring', focused: true },
          ],
        },
      ],
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.findings.some((value) => value.includes('clipped by a non-scrolling container: #clipped')));
    assert.ok(bad.findings.some((value) => value.includes('visible outline or focus ring: no-ring')));
    assert.equal(options.browser.browserContexts().length, 1);
  },
);

test(
  'the state reached by a delayed final expectation receives accessibility checks',
  { skip: !available, timeout: 120000 },
  async (context) => {
    const options = await fixture(
      context,
      '<button id="start">Load results</button><p id="result" role="status">Ready</p>',
      `document.querySelector('#start').onclick=()=>setTimeout(()=>{const button=document.createElement('button');button.id='late';
    document.querySelector('main').append(button);document.querySelector('#result').textContent='Loaded';},1200);`,
    );
    const result = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Load delayed results',
          steps: [
            { type: 'click', selector: '#start' },
            { type: 'expect', selector: '#result', text: 'Loaded' },
          ],
        },
      ],
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some(
        (value) => value.includes('step 2') && value.includes('button-name') && value.includes('#late'),
      ),
    );
    assert.equal(options.browser.browserContexts().length, 1);
  },
);

test(
  'an unmet observable assertion fails and abort never leaves a new context',
  { skip: !available, timeout: 120000 },
  async (context) => {
    const options = await fixture(
      context,
      `<button id="save">Save</button><p id="result">Unchanged</p>
      <label for="date">Date</label><input id="date" value="2026-11-12027-03-04" pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}">
      <label for="password">Password</label><input id="password" type="password" value="never-report-this" pattern="[0-9]+">
      <label for="code">Code</label><textarea id="code" autocomplete="one-time-code">never-report-code</textarea>`,
    );
    const journeys = [
      {
        name: 'Broken save',
        steps: [
          { type: 'click', selector: '#save' },
          { type: 'expect', selector: '#result', text: 'Saved' },
        ],
      },
      {
        name: 'Sensitive assertion',
        steps: [
          { type: 'click', selector: '#save' },
          { type: 'expect', selector: '#code', value: 'never-report-expected' },
        ],
      },
    ];
    const result = await runBrowserJourneys({ ...options, journeys });
    assert.equal(result.ok, false);
    assert.equal(result.journeys, 0);
    const failure = result.findings.find((value) => value.includes('Step 2'));
    assert.ok(failure);
    assert.match(failure, /matches=1; expected count=1 text includes "Saved"/);
    assert.match(failure, /text="Unchanged"/);
    assert.match(failure, /#date.*value="2026-11-12027-03-04".*validity=patternMismatch/);
    assert.match(failure, /#password.*value="\[redacted\]".*validity=patternMismatch/);
    assert.ok(result.findings.every((value) => !value.includes('never-report-this')));
    assert.ok(result.findings.every((value) => !value.includes('never-report-expected')));
    assert.ok(result.findings.every((value) => !value.includes('never-report-code')));
    assert.ok(result.findings[0].includes('Step 2'), 'Primary failures precede repeated rendered findings.');
    assert.equal(result.screenshots.length, 7);
    for (const screenshot of result.screenshots.filter((file) => file.endsWith('-failed.png'))) {
      assert.ok((await fs.stat(screenshot)).size > 1000);
    }
    assert.equal(options.browser.browserContexts().length, 1);
    await assert.rejects(
      runBrowserJourneys({ ...options, journeys, signal: AbortSignal.abort(new Error('Stopped')) }),
      /Stopped/,
    );
    assert.equal(options.browser.browserContexts().length, 1);
  },
);

test(
  'real Chrome accepts a handled duplicate API mutation with newly asserted server feedback',
  {
    skip: !available || process.platform !== 'darwin',
    timeout: 120000,
  },
  async (context) => {
    const options = await fixture(
      context,
      '<label for="title">Title</label><input id="title"><button id="save">Save</button><p id="saved" role="status"></p><p id="error" role="alert"></p>',
      `const show=async()=>{const r=await fetch('./api/record');document.querySelector('#saved').textContent=(await r.json()).title};
    show();document.querySelector('#save').onclick=async()=>{
      const r=await fetch('./api/record',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:document.querySelector('#title').value})});
      if(!r.ok){document.querySelector('#error').textContent=(await r.json()).error;return;}await show();
    };`,
      `import fs from 'node:fs/promises';import path from 'node:path';
    export async function handle(request,{dataDir}){
      const file=path.join(dataDir,'record.json');let record={title:''};
      try{record=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e}
      if(request.method==='POST'){const next=await request.json();
        if(next.title===record.title)return Response.json({error:'Duplicate title: '+next.title},{status:409});
        record=next;await fs.writeFile(file,JSON.stringify(record));}
      return Response.json(record);
    }`,
    );
    const result = await runBrowserJourneys({
      ...options,
      journeys: [
        {
          name: 'Reject a duplicate',
          steps: [
            { type: 'fill', selector: '#title', value: 'Bench vise' },
            { type: 'click', selector: '#save' },
            { type: 'expect', selector: '#saved', text: 'Bench vise' },
            { type: 'click', selector: '#save' },
            { type: 'expect', selector: '#error', text: 'Duplicate title' },
            { type: 'reload' },
            { type: 'expect', selector: '#saved', text: 'Bench vise' },
          ],
        },
      ],
    });
    assert.deepEqual(result.findings, []);
    assert.equal(result.backend.length, 2);
  },
);
