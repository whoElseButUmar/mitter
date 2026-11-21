import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bundledTaskSkillSchema,
  bundledTaskSkills,
  readBundledTaskSkill,
  taskSkillsText,
  writingSkillsText,
} from '../src/task-skills.ts';
import { APP_FOUNDATION_CSS } from '../src/task-skills/app-design.ts';
import { APP_COMPONENTS_JS } from '../src/task-skills/app-components.ts';

test('the immutable default catalog enables the two writing skills and scoped app standards', () => {
  assert.deepEqual(
    bundledTaskSkills.map(({ id, enabledByDefault, scope }) => ({ id, enabledByDefault, scope })),
    [
      { id: 'caveman', enabledByDefault: true, scope: 'writing' },
      { id: 'no-ai-slop', enabledByDefault: true, scope: 'writing' },
      { id: 'ponytail', enabledByDefault: true, scope: 'engineering' },
      { id: 'app-design', enabledByDefault: true, scope: 'web-ui' },
      { id: 'engineering-quality', enabledByDefault: true, scope: 'engineering' },
    ],
  );
  assert.ok(Object.isFrozen(bundledTaskSkills));
  for (const skill of bundledTaskSkills) {
    assert.ok(Object.isFrozen(skill));
    assert.deepEqual(bundledTaskSkillSchema.parse(skill), skill);
  }
});

test('task instructions contain each enabled skill once without repeating detailed references', () => {
  const task = taskSkillsText();
  for (const skill of bundledTaskSkills) {
    assert.equal(task.split(`SKILL ${skill.id}:`).length - 1, 1);
    assert.equal(task.split(skill.promptInstructions).length - 1, 1);
  }
  assert.ok(!task.includes(APP_FOUNDATION_CSS));
  assert.ok(Buffer.byteLength(task, 'utf8') < 5_000, 'Keep per-turn defaults bounded in UTF-8 bytes.');
  assert.equal(taskSkillsText(), task, 'Repeated rendering must preserve exact prompt bytes.');
});

test('the skill lookup returns full task instructions and exact CSS only when requested', () => {
  for (const skill of bundledTaskSkills) {
    const resource = readBundledTaskSkill(skill.id);
    assert.equal(resource.instructions, skill.instructions);
    assert.equal(resource.id, skill.id);
    assert.equal(resource.version, skill.version);
    if (skill.scope === 'web-ui') {
      assert.deepEqual(resource.assets, [{ path: 'foundation.css', content: APP_FOUNDATION_CSS }]);
      resource.assets[0].content = 'changed by caller';
      assert.equal(readBundledTaskSkill(skill.id).assets[0].content, APP_FOUNDATION_CSS);
    } else {
      assert.deepEqual(resource.assets, []);
    }
  }
});

test('the Vite starter keeps app routes and missing crawl resources distinct', () => {
  const { instructions } = readBundledTaskSkill('engineering-quality');
  assert.match(instructions, /without client-side history routes, set appType: "mpa"/);
  assert.match(instructions, /keep its route fallback/);
  assert.match(instructions, /New apps allow crawling by default\. Omit public\/robots\.txt \(return 404\)/);
  assert.match(instructions, /^User-agent: \*\nAllow: \/$/m);
  assert.match(instructions, /Preserve existing or user-requested crawl and indexing restrictions/);
  assert.match(instructions, /Missing optional agent manifests should return 404/);
});

test('the web starter supplies a portable favicon with visible SVG artwork', async () => {
  const { instructions } = readBundledTaskSkill('engineering-quality');
  const link = instructions.match(/<link rel="icon" type="image\/svg\+xml" href="([^"]+)">/);
  assert.ok(link, 'The starter should contain a complete HTML icon link.');
  const icon = await fetch(link[1]);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
  const svg = await icon.text();
  assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]+viewBox="0 0 32 32"/);
  assert.match(svg, /<path [^>]*d="[^"]+"/);
});

test('the engineering reference covers strict TypeScript apps using the bundled JavaScript controls', () => {
  const { instructions } = readBundledTaskSkill('engineering-quality');
  assert.match(instructions, /"allowJs": true and "checkJs": false/);
  assert.match(instructions, /components.d.mts beside components.mjs/);
  assert.match(instructions, /checked element to mount\(root: HTMLElement\)/);
});

test('the Vite browser starter type-checks iterated DOM rows and their typed buttons', async (t) => {
  const { instructions } = readBundledTaskSkill('engineering-quality');
  const sample = instructions.match(/start compilerOptions with (\{[^}]+\})/);
  assert.ok(sample, 'A new app should be able to copy these browser compiler options.');
  const compilerOptions = JSON.parse(sample[1]);
  assert.equal(compilerOptions.strict, true);
  assert.equal(compilerOptions.noEmit, true);
  assert.ok(compilerOptions.lib.includes('DOM.Iterable'), 'TypeScript 5 needs iterable DOM declarations.');
  assert.match(instructions, /Array\.from\(rows\)\.find/);

  const directory = await mkdtemp(join(tmpdir(), 'miter-vite-dom-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: ['rows.ts'] }));
  await writeFile(
    join(directory, 'rows.ts'),
    `const rows = document.querySelectorAll<HTMLLIElement>('li');
const selected = [...rows].find(row => row.dataset.id === 'selected');
selected?.querySelector<HTMLButtonElement>('button')?.focus();
const arrayLikeRows: ArrayLike<HTMLLIElement> = rows;
const fallback = Array.from(arrayLikeRows).find(row => row.dataset.id === 'selected');
fallback?.querySelector<HTMLButtonElement>('button')?.focus();`,
  );
  const tsc = fileURLToPath(new URL('bin/tsc', import.meta.resolve('typescript/package.json')));
  execFileSync(process.execPath, [tsc, '-p', directory], { timeout: 30_000 });
});

test('rewrite defaults carry the writing rules without introducing implementation work', () => {
  const writing = writingSkillsText();
  assert.ok(writing.includes('SKILL caveman:'));
  assert.ok(writing.includes('SKILL no-ai-slop:'));
  assert.ok(!writing.includes('SKILL ponytail:'));
  assert.ok(!writing.includes('SKILL app-design:'));
  assert.ok(!writing.includes('SKILL engineering-quality:'));
  assert.ok(!writing.includes(APP_FOUNDATION_CSS));
  assert.ok(Buffer.byteLength(writing, 'utf8') < 4_000);
});

test('generation and writing defaults reserve decorative UI copy for explicit requests', () => {
  for (const prompt of [taskSkillsText(), writingSkillsText()]) {
    assert.match(
      prompt,
      /promotional subtitles, taglines, decorative text above headings or footer slogans only when the user explicitly requests that copy/i,
    );
    assert.match(prompt, /A visual theme or tone alone does not request it/);
    assert.match(prompt, /accessible names, real constraints, errors and useful empty states/);
    assert.match(prompt, /Skip descriptive subtitles that summarize the screen/);
  }
  const design = readBundledTaskSkill('app-design');
  assert.match(design.instructions, /Audit visible copy before finishing/);
  assert.match(design.instructions, /promotional or editorial copy only to the extent explicitly requested/);
});

test('working controls are a separate bounded read so prompt rendering keeps the complete source', () => {
  const resource = readBundledTaskSkill('app-design', 'components.mjs');
  assert.deepEqual(resource.assets, [{ path: 'components.mjs', content: APP_COMPONENTS_JS }]);
  assert.ok(JSON.stringify(resource).length < 23_000);
  assert.ok(JSON.stringify(readBundledTaskSkill('app-design')).length < 23_000);
  assert.throws(() => readBundledTaskSkill('caveman', 'components.mjs'), /app-design/);
});

test('skill metadata rejects unknown fields, disabled defaults and unrecognized scopes', () => {
  const original = bundledTaskSkills[0];
  assert.ok(original);
  for (const patch of [
    { grantsCommands: true },
    { enabledByDefault: false },
    { scope: 'everything' },
    { instructions: '' },
    { version: 2 },
  ]) {
    assert.equal(bundledTaskSkillSchema.safeParse({ ...original, ...patch }).success, false);
  }
});
