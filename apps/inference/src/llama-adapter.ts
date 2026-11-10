import { parseModelOutput } from './protocol.js';

export type LlamaSession = {
  prompt(
    input: string,
    options: {
      grammar: unknown;
      maxTokens: number;
      temperature: number;
    },
  ): Promise<string>;

  dispose(): void;
};

export type LlamaContext = {
  getSequence(): unknown;

  dispose(): Promise<void>;
};

export type LlamaModel = {
  createContext(options: { contextSize: number }): Promise<LlamaContext>;

  dispose(): Promise<void>;
};

export type LlamaRuntime = {
  loadModel(options: { modelPath: string }): Promise<LlamaModel>;

  getGrammarFor(format: 'json'): Promise<unknown>;
};

export type LlamaModule = {
  getLlama(options: { gpu: false | 'auto' }): Promise<LlamaRuntime>;

  createSession(options: { contextSequence: unknown; systemPrompt: string }): LlamaSession;
};

function objectResource(value: unknown, label: string): Record<string, unknown> {
  if (!isResourceRecord(value)) {
    throw new Error('Invalid local-model ' + label + ' resource.');
  }

  // Native prototype methods must retain their receiver; parsing a record would lose them.

  return value;
}

function isResourceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function method(resource: Record<string, unknown>, name: string): (...arguments_: unknown[]) => unknown {
  const native = resource[name];

  if (typeof native !== 'function') {
    throw new Error('Local-model runtime method is missing: ' + name + '.');
  }

  return (...arguments_) => {
    const result: unknown = Reflect.apply(native, resource, arguments_);

    return result;
  };
}

function adaptContext(value: unknown): LlamaContext {
  const resource = objectResource(value, 'context');
  const getSequence = method(resource, 'getSequence');
  const dispose = method(resource, 'dispose');

  return {
    getSequence() {
      return objectResource(getSequence(), 'context sequence');
    },
    async dispose() {
      await dispose();
    },
  };
}

function adaptModel(value: unknown): LlamaModel {
  const resource = objectResource(value, 'model');
  const createContext = method(resource, 'createContext');
  const dispose = method(resource, 'dispose');

  return {
    async createContext(options) {
      return adaptContext(await createContext(options));
    },
    async dispose() {
      await dispose();
    },
  };
}

function adaptRuntime(value: unknown): LlamaRuntime {
  const resource = objectResource(value, 'llama');
  const loadModel = method(resource, 'loadModel');
  const getGrammarFor = method(resource, 'getGrammarFor');

  return {
    async loadModel(options) {
      return adaptModel(await loadModel(options));
    },
    async getGrammarFor(format) {
      return objectResource(await getGrammarFor(format), 'grammar');
    },
  };
}

/** Dynamic imports are unknown until both callable capabilities and results are checked. */

export function adaptLlamaModule(value: unknown): LlamaModule {
  const resource = objectResource(value, 'module');
  const getLlama = method(resource, 'getLlama');
  const Session = resource.LlamaChatSession;

  if (typeof Session !== 'function') {
    throw new Error('Local-model runtime is missing LlamaChatSession.');
  }

  return {
    async getLlama(options) {
      return adaptRuntime(await getLlama(options));
    },
    createSession(options) {
      const session: unknown = Reflect.construct(Session, [options]);
      const sessionResource = objectResource(session, 'session');
      const prompt = method(sessionResource, 'prompt');
      const dispose = method(sessionResource, 'dispose');

      return {
        async prompt(input, promptOptions) {
          return parseModelOutput(await prompt(input, promptOptions));
        },
        dispose() {
          dispose();
        },
      };
    },
  };
}

export async function loadLlamaModule(): Promise<LlamaModule> {
  const moduleName = 'node-llama-cpp';
  let loaded: unknown;

  try {
    loaded = await import(moduleName);
  } catch (error) {
    throw new Error(
      'Local inference could not load the optional node-llama-cpp runtime. ' +
        'Finish its installation/build or use handoff mode. No model was downloaded.',
      { cause: error },
    );
  }

  return adaptLlamaModule(loaded);
}
