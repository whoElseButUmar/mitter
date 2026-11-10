import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adaptLlamaModule, loadLlamaModule } from '../src/llama-adapter.js';
import { LocalInference, InferenceQueue } from '../src/inference.js';
import { modelCorrelationSchema, modelRequestSchema, modelResponseSchema } from '../src/protocol.js';
const settings = {
  coderModelPath: '',
  contextSize: 8192,
  maxTokens: 2048,
  gpu: 'auto',
};

async function modelFiles(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mitter-inference-test-'));
  t.after(() =>
    fs.rm(root, {
      recursive: true,
      force: true,
    }),
  );
  const first = path.join(root, 'first.gguf');
  const second = path.join(root, 'second.gguf');
  await fs.writeFile(first, 'fixture');
  await fs.writeFile(second, 'fixture');

  return {
    first,
    second,
  };
}

function nativeRuntime(events, options = {}) {
  class Session {
    constructor(configuration) {
      assert.equal(typeof configuration.systemPrompt, 'string');
      events.push('session');

      if (options.creationFailure) {
        throw new Error('session constructor failed');
      }
    }
    async prompt(input) {
      assert.equal(this instanceof Session, true);
      events.push('prompt:' + input);

      if (options.promptFailure) {
        throw new Error('inference failed');
      }

      if (options.invalidResponse) {
        return {
          unchecked: true,
        };
      }

      return '{"actions":[]}';
    }
    dispose() {
      events.push('session disposed');

      if (options.disposeFailure) {
        throw new Error('session disposal failed');
      }
    }
  }

  const context = {
    getSequence() {
      assert.equal(this, context);

      return {};
    },
    async dispose() {
      events.push('context disposed');
    },
  };
  const model = {
    async createContext() {
      assert.equal(this, model);

      return context;
    },
    async dispose() {
      events.push('model disposed');
    },
  };
  const llama = {
    async loadModel(configuration) {
      assert.equal(this, llama);
      events.push('load:' + path.basename(configuration.modelPath));

      return model;
    },
    async getGrammarFor(format) {
      assert.equal(format, 'json');

      return {};
    },
  };

  return {
    async getLlama(configuration) {
      events.push('gpu:' + configuration.gpu);

      return llama;
    },
    LlamaChatSession: Session,
  };
}
test('IPC contracts describe every field and preserve literal model text', () => {
  const schemas = [modelCorrelationSchema, modelRequestSchema, ...modelResponseSchema.options];

  for (const schema of schemas) {
    for (const field of Object.values(schema.shape)) {
      assert.equal(typeof field.description, 'string');
    }
  }

  const input = '\ufeffliteral\r\n  source  ';
  assert.equal(modelRequestSchema.parse({ id: 'literal', method: 'propose', input, settings }).input, input);
  assert.equal(modelResponseSchema.parse({ id: 'literal', ok: true, result: input }).result, input);
  assert.throws(() => modelResponseSchema.parse({ id: 'literal', ok: true, result: input, extra: true }));
  assert.throws(() =>
    modelRequestSchema.parse({ id: 'literal', method: 'propose', input, settings, extra: true }),
  );
});

test('missing local model files fail before optional runtime loading with useful diagnostics', async (t) => {
  const files = await modelFiles(t);
  let loads = 0;
  const inference = new LocalInference(async () => {
    loads++;
    throw new Error('The runtime must not load before the file check.');
  });

  await assert.rejects(inference.propose('prompt', settings), /local GGUF file is required/);
  await assert.rejects(
    inference.propose('prompt', {
      ...settings,
      coderModelPath: files.first + '.missing',
    }),
    (error) => {
      assert.match(error.message, /selected local GGUF file could not be read/);
      assert.match(error.message, /No model was downloaded/);
      assert.equal(error.cause.code, 'ENOENT');
      return true;
    },
  );
  assert.equal(loads, 0);
});

test('absent optional inference runtime gives handoff guidance and preserves its import cause', async (t) => {
  try {
    import.meta.resolve('node-llama-cpp');
    t.skip('Optional runtime is installed; absence is not reproducible in this installation.');
    return;
  } catch (error) {
    assert.equal(error.code, 'ERR_MODULE_NOT_FOUND');
  }

  await assert.rejects(loadLlamaModule(), (error) => {
    assert.match(error.message, /optional node-llama-cpp runtime/);
    assert.match(error.message, /handoff mode/);
    assert.match(error.message, /No model was downloaded/);
    assert.equal(error.cause.code, 'ERR_MODULE_NOT_FOUND');
    return true;
  });
});

test('dynamic model modules are checked before exposing capabilities/results', async () => {
  assert.throws(() =>
    adaptLlamaModule({
      getLlama: true,
    }),
  );
  const invalid = adaptLlamaModule({
    getLlama() {
      return {};
    },
    LlamaChatSession: class {},
  });
  await assert.rejects(
    invalid.getLlama({
      gpu: 'auto',
    }),
    /method is missing/,
  );
  const checked = adaptLlamaModule(
    nativeRuntime([], {
      invalidResponse: true,
    }),
  );
  const llama = await checked.getLlama({
    gpu: 'auto',
  });
  const model = await llama.loadModel({
    modelPath: '/fixture',
  });
  const context = await model.createContext({
    contextSize: 8192,
  });
  const session = checked.createSession({
    contextSequence: context.getSequence(),
    systemPrompt: 'system',
  });
  await assert.rejects(
    session.prompt('prompt', {
      grammar: {},
      maxTokens: 2048,
      temperature: 0.1,
    }),
  );
});
test('inference owns model replacement and disposes every per-request native ' + 'context', async (t) => {
  const files = await modelFiles(t);
  const events = [];
  const inference = new LocalInference(async () => adaptLlamaModule(nativeRuntime(events)));
  await assert.rejects(inference.propose('prompt', settings), /local GGUF/);
  assert.equal(events.length, 0);
  await inference.propose('first', {
    ...settings,
    coderModelPath: files.first,
    gpu: 'cpu',
  });
  await inference.propose('second', {
    ...settings,
    coderModelPath: files.second,
  });
  assert.deepEqual(events, [
    'gpu:false',
    'load:first.gguf',
    'session',
    'prompt:first',
    'session disposed',
    'context disposed',
    'model disposed',
    'load:second.gguf',
    'session',
    'prompt:second',
    'session disposed',
    'context disposed',
  ]);
});
test('failed model retirement or replacement never reuses a retired model on retry', async (context) => {
  const files = await modelFiles(context);

  for (const failure of ['retirement', 'load']) {
    const events = [];
    let failOnce = true;
    const runtime = nativeRuntime(events);
    const getLlama = runtime.getLlama.bind(runtime);
    runtime.getLlama = async (configuration) => {
      const llama = await getLlama(configuration);
      const loadModel = llama.loadModel.bind(llama);
      llama.loadModel = async (modelConfiguration) => {
        if (failure === 'load' && failOnce && modelConfiguration.modelPath === files.second) {
          failOnce = false;
          events.push('load failed');
          throw new Error('Replacement failed.');
        }

        const model = await loadModel(modelConfiguration);
        const dispose = model.dispose.bind(model);
        model.dispose = async () => {
          await dispose();

          if (failure === 'retirement' && failOnce) {
            failOnce = false;
            throw new Error('Retirement failed.');
          }
        };

        return model;
      };

      return llama;
    };
    const inference = new LocalInference(async () => adaptLlamaModule(runtime));
    await inference.propose('first', { ...settings, coderModelPath: files.first });
    await assert.rejects(inference.propose('replacement', { ...settings, coderModelPath: files.second }));
    await inference.propose('retry original', { ...settings, coderModelPath: files.first });
    assert.equal(events.filter((event) => event === 'model disposed').length, 1);
    assert.equal(events.filter((event) => event === 'load:first.gguf').length, 2);
    assert.equal(events.filter((event) => event.startsWith('prompt:')).length, 2);
    assert.equal(events.at(-1), 'context disposed');
  }
});

test(
  'context cleanup still runs when session creation, inference or session ' + 'disposal fails',
  async (t) => {
    const files = await modelFiles(t);

    for (const failure of ['creationFailure', 'promptFailure', 'disposeFailure']) {
      const events = [];
      const inference = new LocalInference(async () =>
        adaptLlamaModule(
          nativeRuntime(events, {
            [failure]: true,
          }),
        ),
      );
      await assert.rejects(
        inference.propose('prompt', {
          ...settings,
          coderModelPath: files.first,
        }),
      );
      assert.equal(events.at(-1), 'context disposed');
    }
  },
);
test(
  'IPC schemas reject malformed requests/results and inference queue ' + 'recovers after a failed send',
  async () => {
    assert.throws(() =>
      modelRequestSchema.parse({
        id: 'request',
        method: 'propose',
        input: 'prompt',
        settings: {},
      }),
    );
    assert.throws(() =>
      modelResponseSchema.parse({
        id: 'request',
        ok: true,
        result: {},
      }),
    );
    assert.throws(() =>
      modelRequestSchema.parse({
        id: 'request',
        method: 'propose',
        input: 'prompt',
        settings: {
          ...settings,
          maxTokens: 8192,
        },
      }),
    );
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const calls = [];
    const responses = [];
    const failures = [];
    const queue = new InferenceQueue(
      {
        async propose(input) {
          calls.push(input);

          if (input === 'first') {
            started.resolve();
            await release.promise;
          }

          return input;
        },
      },
      (response) => {
        if (response.id === 'first') {
          throw new Error('IPC failed');
        }
        responses.push(response);
      },
      (error) => failures.push(error),
    );
    const first = queue.submit({
      id: 'first',
      method: 'propose',
      input: 'first',
      settings,
    });
    const second = queue.submit({
      id: 'second',
      method: 'propose',
      input: 'second',
      settings,
    });
    await started.promise;
    assert.deepEqual(calls, ['first']);
    release.resolve();
    await Promise.all([first, second]);
    await queue.submit({
      id: 'invalid',
      method: 'delete',
      input: 'ignored',
      settings,
    });
    await queue.submit(null);
    await queue.submit({ id: 3, method: 'propose', input: 'ignored', settings });
    await queue.submit({ id: 'bad_settings', method: 'propose', input: 'ignored', settings: {} });
    assert.deepEqual(calls, ['first', 'second']);
    assert.equal(failures.length, 1);
    assert.equal(responses[0].result, 'second');
    assert.equal(responses[1].ok, false);
    assert.equal(responses[1].id, 'invalid');
    const invalidRequest = modelRequestSchema.safeParse({
      id: 'invalid',
      method: 'delete',
      input: 'ignored',
      settings,
    });
    assert.equal(invalidRequest.success, false);
    assert.equal(responses[1].error, invalidRequest.error.message);
    assert.equal(responses[2].id, 'bad_settings');
    assert.equal(responses[2].ok, false);
    assert.equal(responses.length, 3);
  },
);
