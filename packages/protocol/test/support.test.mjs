import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { parseSchema } from '../src/helpers.ts';
import { followupRequestSchema } from '../src/schemas/requests.ts';
import { DEFAULT_SETTINGS, parseModelSettings, restoreModelSettings } from '../src/model-settings.ts';
import { parseFollowup, parseSelection, summarizeFollowup } from '../src/requests.ts';
import { parseRewriteReply, parseRewriteRequest, rewritePrompt, structureLocally } from '../src/rewrite.ts';
import { buildTaskBrief, displayTaskName, suggestedTaskName, taskBriefText } from '../src/task-brief.ts';

const selection = {
  path: 'a.ts',
  hash: 'a'.repeat(64),
  start: 0,
  end: 2,
  text: '😀',
};

test('model settings retain RPC defaults and cross-field/unknown-field errors', () => {
  assert.deepEqual(parseModelSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(
    parseModelSettings({
      coderModelPath: null,
      contextSize: null,
      maxTokens: null,
      gpu: null,
    }),
    DEFAULT_SETTINGS,
  );
  assert.throws(() => parseModelSettings({ maxTokens: 8192 }), {
    message: 'Output token limit must be smaller than context size.',
  });
  assert.throws(() => parseModelSettings({ gpu: 'bad', coderModelPath: '\u0000' }), {
    message: 'Choose auto or cpu.',
  });
  assert.throws(() => parseModelSettings({ extra: true }), {
    message: 'Unexpected field: extra',
  });
});

test('saved model settings use supported own properties and bounded recovery only', () => {
  assert.deepEqual(restoreModelSettings(Object.create({ contextSize: 2048, gpu: 'cpu' })), DEFAULT_SETTINGS);
  assert.deepEqual(
    restoreModelSettings({
      extra: true,
      contextSize: 2048,
      maxTokens: 8192,
      coderModelPath: '\u0000',
      gpu: 'cpu',
    }),
    {
      coderModelPath: '',
      contextSize: 2048,
      maxTokens: 1024,
      gpu: 'cpu',
    },
  );
  assert.equal(restoreModelSettings({ coderModelPath: '  exact path  ' }).coderModelPath, '  exact path  ');
});

test('saved model settings retain field bounds, exact paths and independent recovery', () => {
  for (const [key, minimum, maximum] of [
    ['contextSize', 2048, 32_768],
    ['maxTokens', 256, 8192],
  ]) {
    for (const value of [minimum, maximum]) {
      assert.equal(restoreModelSettings({ contextSize: 32_768, [key]: value })[key], value);
    }

    for (const value of [undefined, null, NaN, Infinity, '2048', minimum - 1, maximum + 1, minimum + 0.5]) {
      assert.equal(restoreModelSettings({ contextSize: 32_768, [key]: value })[key], DEFAULT_SETTINGS[key]);
    }
  }

  for (const coderModelPath of ['', '  exact path  ', ' '.repeat(2000)]) {
    assert.equal(restoreModelSettings({ coderModelPath }).coderModelPath, coderModelPath);
  }

  for (const coderModelPath of [null, 42, 'x'.repeat(2001), 'path\u0000']) {
    assert.equal(restoreModelSettings({ coderModelPath, gpu: 'cpu' }).coderModelPath, '');
    assert.equal(restoreModelSettings({ coderModelPath, gpu: 'cpu' }).gpu, 'cpu');
  }

  for (const gpu of [undefined, null, 'auto', 'CPU', false, 1]) {
    assert.equal(restoreModelSettings({ gpu }).gpu, 'auto');
  }

  const inherited = Object.create({ coderModelPath: 'inherited', contextSize: 2048, maxTokens: 256 });
  inherited.gpu = 'cpu';
  assert.deepEqual(restoreModelSettings(inherited), { ...DEFAULT_SETTINGS, gpu: 'cpu' });
});

test('selection range and selected literal text remain UTF-16 exact', () => {
  assert.deepEqual(parseSelection(selection), selection);
  assert.throws(() => parseSelection({ ...selection, end: 1 }), {
    message: 'The selection range does not match its text. Select the code again.',
  });
  assert.throws(() => parseSelection({ ...selection, hash: 'A'.repeat(64) }), {
    message: 'Select code from a fully loaded source file.',
  });
});

test('follow-up trimming is preserved and only an omitted autoStart flag defaults to true', () => {
  assert.deepEqual(parseFollowup({ id: 'f', instruction: '  request  ' }), {
    id: 'f',
    instruction: 'request',
    autoStart: true,
  });
  assert.equal(parseFollowup({ id: 'f', instruction: 'request', autoStart: false }).autoStart, false);
  assert.equal(parseFollowup({ id: 'f', instruction: 'request', autoStart: true }).autoStart, true);
  assert.equal(parseFollowup({ id: 'f', instruction: 'request', autoStart: undefined }).autoStart, true);
  assert.throws(() => parseFollowup({ id: 'f', instruction: 'request', selection: null }), {
    message: 'Expected code selection.',
  });
  const summary = summarizeFollowup({
    id: 'f',
    workerId: 'w',
    instruction: 'x'.repeat(601),
    status: 'queued',
    createdAt: 1,
    baseRunId: 'run',
    autoStart: true,
    selection,
  });
  assert.equal(summary.instruction.length, 600);
  assert.equal(summary.path, 'a.ts');
  assert.ok(Object.hasOwn(summary, 'error'));
});

test('malformed follow-up autoStart flags are rejected before a request can enable execution', () => {
  for (const autoStart of [null, '', 'true', 'false', 0, 1, -1, 0.5, NaN, Infinity, {}, []]) {
    const request = { id: 'f', instruction: '  request  ', autoStart, selection };
    const effects = [];
    assert.equal(followupRequestSchema.safeParse(request).success, false);
    assert.throws(
      () => {
        const parsed = parseFollowup(request);
        effects.push(parsed);
      },
      (error) => {
        assert.equal(error.message, 'Invalid autoStart. Use true or false.');
        assert.ok(error.cause instanceof z.ZodError);
        return true;
      },
    );
    assert.deepEqual(effects, []);
    assert.equal(request.autoStart, autoStart);
    assert.deepEqual(request.selection, selection);
  }
});

test('parseSchema retains the exact validation error as its cause without changing the friendly message', () => {
  const schema = z
    .object({
      name: z.string({ error: 'Choose a name.' }).describe('The required display name.'),
      count: z.int().describe('The required item count.'),
    })
    .describe('A boundary fixture with two independent validation errors.');
  const result = schema.safeParse({});
  assert.equal(result.success, false);
  const boundary = { safeParse: () => result };
  assert.throws(
    () => parseSchema(boundary, {}),
    (error) => {
      assert.equal(error.message, 'Choose a name.');
      assert.equal(error.cause, result.error);
      assert.equal(error.cause.issues.length, 2);
      return true;
    },
  );
});

test('parseSchema retains an empty validation error as the fallback message cause', () => {
  const failure = new z.ZodError([]);
  const schema = { safeParse: () => ({ success: false, error: failure }) };
  assert.throws(
    () => parseSchema(schema, 'value'),
    (error) => {
      assert.equal(error.message, 'The value does not match the schema.');
      assert.equal(error.cause, failure);
      return true;
    },
  );
});

test('rewrites preserve draft whitespace and require exact request correlation', () => {
  const request = {
    instruction: '  exact "draft"  ',
    mode: 'clarity',
    provider: 'local',
  };
  assert.deepEqual(parseRewriteRequest(request), request);
  assert.ok(structureLocally(request).startsWith('Requested change:\n  exact "draft"  \n'));
  assert.ok(rewritePrompt(request, 'request').endsWith(JSON.stringify(request.instruction)));
  const reply = {
    protocol: 'miter-rewrite/1',
    requestId: 'request',
    text: '  exact  ',
  };
  assert.equal(parseRewriteReply('```JSON\n' + JSON.stringify(reply) + '\n```', 'request'), '  exact  ');
  assert.throws(() => parseRewriteReply(JSON.stringify(reply), 'other'), {
    message: 'The rewrite did not match this request. No draft was changed.',
  });
  assert.throws(() => parseRewriteReply('prose\n' + JSON.stringify(reply), 'request'), {
    message: 'The rewrite was not valid JSON. No draft was changed.',
  });
  assert.throws(() => structureLocally({ ...request, instruction: 'x'.repeat(4000) }), {
    message: 'The draft is too long to add a local brief. Choose Shorter with ChatGPT, or shorten it first.',
  });
});

test('task shaping remains deterministic, subordinate and display-only', () => {
  assert.equal(buildTaskBrief('make a tic-tac-toe game').kind, 'tic-tac-toe');
  assert.equal(suggestedTaskName('make a color memory game'), 'Color Memory');
  assert.equal(
    displayTaskName({
      name: 'My explicit name',
      goal: 'make a tic-tac-toe game',
    }),
    'My explicit name',
  );
  const changed = buildTaskBrief('fix tic-tac-toe game');
  assert.equal(
    changed.defaults.some((value) => value.includes('two local players')),
    false,
  );
  assert.ok(changed.approach.some((value) => value.includes('Do not rebuild unrelated features.')));
  assert.ok(taskBriefText('build a game').includes('No browser-testing tool is implied by this brief.'));
});
