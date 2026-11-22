import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { browserExecutable } from '../quality/browser-executable.ts';
import { launchPreviewBrowser, closeBrowser } from '../quality/browser-launch.ts';
import { verifyProjectQuality } from '../quality/gate.ts';
import { fixture } from './test-fixture.mjs';

test(
  'the shipped starter passes Miter web verification and retains its saved note across a real project Restart',
  {
    skip: process.platform !== 'darwin' || !process.env.MITER_TEST_STARTER_RELEASE,
    timeout: 600000,
  },
  async (t) => {
    const { service, root, dataDir } = await fixture(t);
    const project = await service.handle('project.create', {
      parentRoot: path.dirname(root),
      folderName: 'studio-notes',
      name: 'Studio notes',
      starter: 'vite-ts-sqlite',
    });
    const evidence = await verifyProjectQuality({
      root: project.root,
      dataDir,
      changedPaths: [],
      commandsRan: false,
      verifyExistingWebApp: true,
      skillsRead: ['app-design', 'engineering-quality'],
      signal: AbortSignal.timeout(480000),
      beforeTests: () => {},
    });
    assert.deepEqual(
      evidence
        .filter((result) => !result.ok)
        .map(({ check, detail, finding }) => ({ check, detail, finding })),
      [],
    );
    const byName = new Map(evidence.map((result) => [result.check.name, result]));
    for (const name of ['components', 'syntax', 'tests', 'browser', 'lighthouse', 'snapshot']) {
      assert.ok(byName.get(name)?.ok, name);
    }
    const reports = JSON.parse(byName.get('lighthouse').detail);
    assert.deepEqual(reports.scores.map((score) => score.device).sort(), ['desktop', 'mobile']);
    for (const { device, categories } of reports.scores) {
      t.diagnostic(device + ' ' + JSON.stringify(categories));
      assert.ok(
        Object.values(categories)
          .filter((score) => score !== null)
          .every((score) => score === 100),
      );
    }

    const task = await service.handle('project.starterTask', { projectId: project.id });
    assert.equal(task.mode, 'local');
    await service.handle('worker.run', { workerId: task.id, expectedRun: { runId: task.runId, epoch: 0 } });
    await service.wait(task.id);
    const current = service.workers.get(task.id);
    assert.equal(current.state, 'complete', current.error);
    const boundary = {
      workerId: task.id,
      expectedRun: { runId: current.runId, epoch: current.control?.epoch ?? 0 },
    };
    const preview = await service.handle('worker.previewStart', { ...boundary, mode: 'run' });

    const chrome = await browserExecutable();
    assert.ok(chrome);
    async function visit(url, operation) {
      const profile = await fs.mkdtemp(path.join(dataDir, 'starter-browser-'));
      await Promise.all(['home', 'tmp'].map((dir) => fs.mkdir(path.join(profile, dir))));
      const browser = await launchPreviewBrowser(chrome, profile, url);
      try {
        const page = await browser.newPage();
        await page.goto(url);
        await operation(page);
      } finally {
        await closeBrowser(browser);
      }
    }
    const note = 'Restored after the studio reopened';
    await visit(preview.url, async (page) => {
      await page.type('#note-body', note);
      await page.click('#save-note');
      await page.waitForFunction(
        (value) => document.querySelector('#notes')?.textContent.includes(value),
        {},
        note,
      );
    });
    const restarted = await service.handle('worker.previewStart', {
      ...boundary,
      mode: 'restart',
      replacePreviewId: preview.previewId,
    });
    assert.notEqual(restarted.previewId, preview.previewId);
    await visit(restarted.url, async (page) => {
      await page.waitForFunction(
        (value) => document.querySelector('#notes')?.textContent.includes(value),
        {},
        note,
      );
      const notes = await page.evaluate(async () => (await fetch('/api/notes')).json());
      assert.deepEqual(
        notes.map((record) => record.body),
        [note],
      );
    });
    await service.handle('worker.previewStop', { ...boundary, previewId: restarted.previewId });
  },
);
