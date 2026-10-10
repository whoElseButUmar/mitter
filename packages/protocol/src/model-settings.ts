import type { Settings } from './index.js';
import { integer, object, only, text } from './index.js';

/** Shared by the host and UI. Unknown persisted fields are not runtime options. */
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  coderModelPath: '', contextSize: 8192, maxTokens: 2048, gpu: 'auto',
});
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);

/** RPC input is strict: unsupported fields never grant new capabilities. */
export function parseModelSettings(value: unknown): Settings {
  const s = object(value, 'settings');
  only(s, SETTINGS_KEYS);
  const gpu = s.gpu ?? DEFAULT_SETTINGS.gpu;
  if (gpu !== 'auto' && gpu !== 'cpu') throw new Error('Choose auto or cpu.');
  const next: Settings = {
    coderModelPath: text(s.coderModelPath ?? '', 'model path', 2000, true),
    contextSize: integer(s.contextSize ?? DEFAULT_SETTINGS.contextSize, 'context', 2048, 32768),
    maxTokens: integer(s.maxTokens ?? DEFAULT_SETTINGS.maxTokens, 'output tokens', 256, 8192),
    gpu,
  };
  if (next.maxTokens >= next.contextSize) throw new Error('Output token limit must be smaller than context size.');
  return next;
}

/** Upgrade old settings by copying supported own properties, never spreading a
 * saved object. No model files are loaded, deleted or downloaded during startup.
 * Invalid values get bounded defaults instead of preventing the host from booting. */
export function restoreModelSettings(value: unknown): Settings {
  const s = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const own = (key: keyof Settings): unknown => Object.hasOwn(s, key) ? s[key] : undefined;
  const bounded = (key: 'contextSize' | 'maxTokens', min: number, max: number): number => {
    const n = own(key);
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max
      ? n : DEFAULT_SETTINGS[key];
  };
  const modelPath = own('coderModelPath');
  const contextSize = bounded('contextSize', 2048, 32768);
  const maxTokens = bounded('maxTokens', 256, 8192);
  return {
    coderModelPath: typeof modelPath === 'string' && modelPath.length <= 2000 && !modelPath.includes('\0') ? modelPath : '',
    contextSize,
    maxTokens: maxTokens < contextSize ? maxTokens : Math.min(DEFAULT_SETTINGS.maxTokens, Math.floor(contextSize / 2)),
    gpu: own('gpu') === 'cpu' ? 'cpu' : 'auto',
  };
}
