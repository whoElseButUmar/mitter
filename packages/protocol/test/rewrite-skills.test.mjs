import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REWRITE_MODES, parseRewriteReply, rewritePrompt, structureLocally } from '../src/rewrite.ts';
import { writingSkillsText } from '../src/task-skills.ts';

test('every rewrite mode includes writing defaults once while preserving the quoted draft and reply contract', () => {
  const instruction = '  Keep `ticks`, "quotes", \\paths, &#x20;, 😀,\r\n and exact spacing.  ';
  const defaults = writingSkillsText();
  assert.notEqual(defaults, '');

  for (const mode of Object.keys(REWRITE_MODES)) {
    const request = { mode, provider: 'chatgpt', instruction };
    const prompt = rewritePrompt(request, 'exact-request-id');
    assert.equal(prompt.split(defaults).length - 1, 1);
    assert.equal(prompt.split('SKILL caveman:').length - 1, 1);
    assert.equal(prompt.split('SKILL no-ai-slop:').length - 1, 1);
    assert.doesNotMatch(prompt, /SKILL (?:ponytail|app-design|engineering-quality):/);
    assert.ok(prompt.includes(REWRITE_MODES[mode].instruction));
    assert.ok(prompt.endsWith('\n\nDRAFT (JSON string):\n' + JSON.stringify(instruction)));
    assert.ok(
      prompt.includes(
        JSON.stringify({
          protocol: 'miter-rewrite/1',
          requestId: 'exact-request-id',
          text: 'rewritten request',
        }),
      ),
    );
    assert.match(prompt, /Do not implement it, call project tools, or provide code/);
    assert.match(prompt, /Return ONLY one fenced json block/);
    assert.match(prompt, /Output at most 4,000 characters/);
    assert.equal(request.instruction, instruction);
  }
});

test('writing defaults do not change draft-only response validation or deterministic local templates', () => {
  const instruction = '  Keep all literal text.  ';
  const local = structureLocally({ instruction, provider: 'local', mode: 'concise' });
  assert.ok(local.startsWith('Requested change:\n' + instruction + '\n'));
  assert.equal(local.includes(writingSkillsText()), false);
  const response = { protocol: 'miter-rewrite/1', requestId: 'exact', text: instruction };
  assert.equal(parseRewriteReply('```json\n' + JSON.stringify(response) + '\n```', 'exact'), instruction);
  assert.throws(() => parseRewriteReply(JSON.stringify(response), 'different'), /did not match/);
  assert.throws(
    () => parseRewriteReply(JSON.stringify({ ...response, actions: [{ type: 'finish' }] }), 'exact'),
    /did not match/,
  );
  assert.throws(
    () => parseRewriteReply(JSON.stringify({ ...response, text: 'x'.repeat(4001) }), 'exact'),
    /did not match/,
  );
});
