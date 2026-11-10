import { object, only, parseSchema } from './helpers.js';
import { isRecord } from './schemas/primitives.js';
import { settingsSchema, type Settings } from './schemas/model-settings.js';

export { settingsSchema } from './schemas/model-settings.js';

/** Shared defaults do not load, delete or download model files. */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  coderModelPath: '',
  contextSize: 8192,
  maxTokens: 2048,
  gpu: 'auto',
});

/** RPC input is strict; only this legacy boundary supplies nullish defaults. */
export function parseModelSettings(value: unknown): Settings {
  const settings = object(value, 'settings');
  only(settings, Object.keys(settingsSchema.shape));

  const gpu = parseSchema(settingsSchema.shape.gpu, settings.gpu ?? DEFAULT_SETTINGS.gpu);

  return parseSchema(settingsSchema, {
    coderModelPath: settings.coderModelPath ?? DEFAULT_SETTINGS.coderModelPath,
    contextSize: settings.contextSize ?? DEFAULT_SETTINGS.contextSize,
    maxTokens: settings.maxTokens ?? DEFAULT_SETTINGS.maxTokens,
    gpu,
  });
}

/** Upgrade persisted supported own properties only. Invalid saved values receive
 * bounded defaults instead of preventing startup; unknown keys are ignored. */
export function restoreModelSettings(value: unknown): Settings {
  let settings: Record<string, unknown> = {};

  if (isRecord(value)) {
    settings = value;
  }

  function own(key: keyof Settings): unknown {
    if (Object.hasOwn(settings, key)) {
      return settings[key];
    }

    return undefined;
  }

  const restored = {
    coderModelPath: settingsSchema.shape.coderModelPath
      .catch(DEFAULT_SETTINGS.coderModelPath)
      .parse(own('coderModelPath')),
    contextSize: settingsSchema.shape.contextSize
      .catch(DEFAULT_SETTINGS.contextSize)
      .parse(own('contextSize')),
    maxTokens: settingsSchema.shape.maxTokens.catch(DEFAULT_SETTINGS.maxTokens).parse(own('maxTokens')),
    gpu: settingsSchema.shape.gpu.catch(DEFAULT_SETTINGS.gpu).parse(own('gpu')),
  };

  if (restored.maxTokens >= restored.contextSize) {
    restored.maxTokens = Math.min(DEFAULT_SETTINGS.maxTokens, Math.floor(restored.contextSize / 2));
  }

  return restored;
}
