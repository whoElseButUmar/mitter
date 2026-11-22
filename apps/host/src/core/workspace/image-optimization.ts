import path from 'node:path';
import sharp from 'sharp';

const maxInputPixels = 64_000_000;
const maxWebEdge = 1280;
const webByteTarget = 96 * 1024;

export function webImagePath(relative: string): string {
  const extension = path.posix.extname(relative);
  if (extension.toLowerCase() === '.webp') {
    return relative;
  }
  return relative.slice(0, relative.length - extension.length) + '.webp';
}

function isAnimatedPng(bytes: Buffer): boolean {
  // APNG declares its frame count before the first image data chunk.
  for (let offset = 8; offset + 12 <= bytes.length; offset += 12 + bytes.readUInt32BE(offset)) {
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') {
      return true;
    }
    if (type === 'IDAT' || type === 'IEND') {
      break;
    }
  }
  return false;
}

export async function optimizeProjectImage(bytes: Buffer, relative: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const source = sharp(bytes, { limitInputPixels: maxInputPixels, autoOrient: true }).timeout({
    seconds: 10,
  });
  try {
    const metadata = await source.metadata();
    signal.throwIfAborted();
    const { width, height } = metadata.autoOrient;
    const original = { bytes, path: relative, width, height };
    if (
      (metadata.pages ?? 1) > 1 ||
      (metadata.format === 'png' && isAnimatedPng(bytes)) ||
      (bytes.length <= 32 * 1024 && Math.max(width, height) <= maxWebEdge)
    ) {
      return original;
    }

    const encode = (edge: number, quality: number) =>
      source
        .clone()
        .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality })
        .toBuffer({ resolveWithObject: true });

    let result = await encode(maxWebEdge, 78);
    signal.throwIfAborted();
    if (result.data.length > webByteTarget) {
      const smaller = await encode(960, 75);
      signal.throwIfAborted();
      if (smaller.data.length < result.data.length) {
        result = smaller;
      }
    }
    if (result.data.length >= bytes.length) {
      return original;
    }
    return {
      bytes: result.data,
      path: webImagePath(relative),
      width: result.info.width,
      height: result.info.height,
    };
  } catch (cause) {
    signal.throwIfAborted();
    throw new Error('Miter could not process this image. Try a smaller, valid image file.', { cause });
  }
}
