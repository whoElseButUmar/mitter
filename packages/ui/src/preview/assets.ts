import {
  PREVIEW_LIMIT,
  PREVIEW_CHUNK_SIZE,
  PreviewChunkSchema,
  type PreviewAsset,
  type PreviewRPC,
} from './schemas.js';
import { FileTargetSchema } from '../file-target.js';

export async function loadAsset(
  rpc: PreviewRPC,
  workerId: string,
  path: string,
  signal?: AbortSignal,
): Promise<PreviewAsset> {
  signal?.throwIfAborted();
  const target = FileTargetSchema.parse({ workerId, path });
  let offset = 0;
  let metadata: Pick<PreviewAsset, 'mime' | 'size' | 'stamp'> | undefined;
  const chunks: Uint8Array[] = [];

  do {
    signal?.throwIfAborted();
    const params: Record<string, unknown> = {
      ...target,
      offset,
      length: PREVIEW_CHUNK_SIZE,
    };

    if (metadata) {
      params.stamp = metadata.stamp;
    }

    const value: unknown = await rpc('worker.asset', params);
    signal?.throwIfAborted();
    const result = PreviewChunkSchema.safeParse(value);

    if (!result.success) {
      throw new Error('The file preview response is invalid. Reload the file.', { cause: result.error });
    }

    const chunk = result.data;

    if (chunk.path !== path || chunk.size > PREVIEW_LIMIT || chunk.offset !== offset) {
      throw new Error('The file changed or exceeded the preview limit. Reload the file.');
    }

    if (metadata) {
      if (chunk.size !== metadata.size || chunk.mime !== metadata.mime || chunk.stamp !== metadata.stamp) {
        throw new Error('The file changed or exceeded the preview limit. Reload the file.');
      }
    } else {
      metadata = { mime: chunk.mime, size: chunk.size, stamp: chunk.stamp };
    }
    const binary = atob(chunk.data);
    const part = Uint8Array.from(binary, (character) => character.charCodeAt(0));

    const nextOffset = offset + part.length;

    if (part.length > PREVIEW_CHUNK_SIZE || nextOffset > metadata.size || nextOffset > PREVIEW_LIMIT) {
      throw new Error('Incomplete preview. Reload the file.');
    }

    if (!part.length && !chunk.eof) {
      throw new Error('Preview stream ended before the file was complete.');
    }

    // A host read may be short, but EOF must exactly match the declared total byte length.
    if (chunk.eof !== (nextOffset === metadata.size)) {
      throw new Error('Incomplete preview. Reload the file.');
    }

    chunks.push(part);
    offset = nextOffset;

    if (chunk.eof) {
      break;
    }
  } while (offset < PREVIEW_LIMIT);

  if (!metadata || offset !== metadata.size) {
    throw new Error('Incomplete preview. Reload the file.');
  }

  const { mime, size, stamp } = metadata;
  const bytes = new Uint8Array(size);
  let position = 0;

  for (const part of chunks) {
    bytes.set(part, position);
    position += part.length;
  }

  return { path, mime, size, bytes, stamp };
}

export function isTextAsset(asset: PreviewAsset): boolean {
  return asset.mime.startsWith('text/') || ['application/json', 'image/svg+xml'].includes(asset.mime);
}

export function assetText(asset: PreviewAsset): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(asset.bytes);
}

export function assetDataURL(asset: PreviewAsset): string {
  let binary = '';

  for (let index = 0; index < asset.bytes.length; index += 32768) {
    binary += String.fromCharCode(...asset.bytes.subarray(index, index + 32768));
  }

  return 'data:' + asset.mime + ';base64,' + btoa(binary);
}

export function localDependency(from: string, reference: string): string | undefined {
  const value = reference.trim();

  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) {
    return undefined;
  }

  const [path] = value.split(/[?#]/);
  let name: string;

  try {
    name = decodeURIComponent(path || '');
  } catch {
    return undefined;
  }

  if (!name || name.includes('\\') || name.includes('\0')) {
    return undefined;
  }

  let parts = from.split('/').slice(0, -1);

  if (name.startsWith('/')) {
    parts = [];
  }

  for (const part of name.split('/')) {
    if (part === '.' || !part) {
      continue;
    }

    if (part === '..') {
      if (!parts.length) {
        return undefined;
      }

      parts.pop();
    } else {
      parts.push(part);
    }
  }

  return parts.join('/') || undefined;
}
