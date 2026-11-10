import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadLlamaModule } from './llama-adapter.js';
import type { LlamaModule, LlamaModel, LlamaRuntime, LlamaSession } from './llama-adapter.js';
import { modelCorrelationSchema, modelRequestSchema, parseModelOutput } from './protocol.js';
import type { ModelSettings, ModelResponse } from './protocol.js';

/** The worker serializes calls so model replacement cannot race a live context. */

export class LocalInference {
  private module: LlamaModule | undefined;
  private llama: LlamaRuntime | undefined;
  private loaded: { path: string; model: LlamaModel } | undefined;

  constructor(private load: () => Promise<LlamaModule> = loadLlamaModule) {}

  async propose(prompt: string, settings: ModelSettings): Promise<string> {
    if (!path.isAbsolute(settings.coderModelPath)) {
      throw new Error('A local GGUF file is required. No model is downloaded automatically.');
    }

    try {
      await fs.access(settings.coderModelPath);
    } catch (error) {
      throw new Error(
        'The selected local GGUF file could not be read. Select an existing readable model file. ' +
          'No model was downloaded.',
        { cause: error },
      );
    }

    if (!this.module) {
      this.module = await this.load();
    }

    const module = this.module;

    if (!this.llama) {
      let gpu: false | 'auto' = 'auto';

      if (settings.gpu === 'cpu') {
        gpu = false;
      }
      this.llama = await module.getLlama({
        gpu,
      });
    }

    const llama = this.llama;

    if (!this.loaded || this.loaded.path !== settings.coderModelPath) {
      const previous = this.loaded;
      this.loaded = undefined;
      await previous?.model.dispose();
      const model = await llama.loadModel({ modelPath: settings.coderModelPath });
      this.loaded = { path: settings.coderModelPath, model };
    }

    const context = await this.loaded.model.createContext({
      contextSize: settings.contextSize,
    });
    let session: LlamaSession | undefined;

    try {
      session = module.createSession({
        contextSequence: context.getSequence(),
        systemPrompt:
          'You are Mitter’s local coding worker. Produce only the JSON action ' +
          'object requested. Never invent test results.',
      });
      const grammar = await llama.getGrammarFor('json');

      return await session.prompt(prompt, {
        grammar,
        maxTokens: settings.maxTokens,
        temperature: 0.1,
      });
    } finally {
      try {
        session?.dispose();
      } finally {
        await context.dispose();
      }
    }
  }
}

export class InferenceQueue {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private inference: { propose: (prompt: string, settings: ModelSettings) => Promise<unknown> },
    private send: (response: ModelResponse) => void,
    private onError: (error: unknown) => void,
  ) {}

  submit(message: unknown): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        let response: ModelResponse;

        try {
          const request = modelRequestSchema.parse(message);
          const result = parseModelOutput(await this.inference.propose(request.input, request.settings));
          response = {
            id: request.id,
            ok: true,
            result,
          };
        } catch (error) {
          const correlation = modelCorrelationSchema.safeParse(message);

          if (!correlation.success) {
            return;
          }

          let detail = String(error);

          if (error instanceof Error) {
            detail = error.message;
          }
          response = {
            id: correlation.data.id,
            ok: false,
            error: detail,
          };
        }
        this.send(response);
      })
      .catch((error) => {
        // A failed IPC send must not poison the queue and strand subsequent requests.
        this.onError(error);
      });

    return this.chain;
  }
}
