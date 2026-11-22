import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
} from '../../../../../packages/protocol/src/schemas/image-attachments.js';

type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

const extensions = new Map<string, ImageMime>([
  ['.png', 'image/png'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxRedirects = 4;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const pngEnd = Buffer.from('0000000049454e44ae426082', 'hex');

function imageMime(bytes: Buffer): ImageMime | undefined {
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 14) {
    return undefined;
  }

  if (
    bytes.length >= 45 &&
    bytes.subarray(0, 8).equals(pngSignature) &&
    bytes.toString('latin1', 12, 16) === 'IHDR' &&
    bytes.subarray(-12).equals(pngEnd)
  ) {
    return 'image/png';
  }
  if (
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.readUInt16BE(bytes.length - 2) === 0xffd9
  ) {
    return 'image/jpeg';
  }
  if (/^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6)) && bytes.at(-1) === 0x3b) {
    return 'image/gif';
  }
  if (
    bytes.length >= 20 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.readUInt32LE(4) === bytes.length - 8 &&
    /^WEBPVP8[ LX]$/.test(bytes.toString('latin1', 8, 16))
  ) {
    return 'image/webp';
  }
  return undefined;
}

export function validateProjectImage(bytes: Buffer, filename: string): void {
  const expected = extensions.get(path.extname(filename).toLowerCase());
  if (!expected) {
    throw new Error('Use a .png, .jpg, .jpeg, .webp, or .gif filename for the image.');
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('The image exceeds the 5 MiB limit. Choose a smaller image.');
  }
  if (imageMime(bytes) !== expected) {
    throw new Error(
      'The image data does not match the filename. Use the filename extension for its actual format.',
    );
  }
}

function publicUrl(value: string, base?: URL): URL {
  const url = URL.parse(value, base);
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z](?:[a-z\d-]*[a-z\d])?$/i.test(url.hostname) ||
    /\.(?:localhost|local|internal|test|invalid|onion|home\.arpa)$/i.test(url.hostname)
  ) {
    throw new Error('Use a public HTTPS image URL without a login or custom port.');
  }
  return url;
}

function publicAddress(address: string): boolean {
  const [first, second, third] = address.split('.').map(Number);
  if (!isIPv4(address) || first === undefined || second === undefined || third === undefined) {
    return false;
  }

  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 168 || (second === 0 && (third === 0 || third === 2)))) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100))) ||
    (first === 203 && second === 0 && third === 113)
  );
}

function requestImage(url: URL, address: string, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    // Connect to the vetted address. TLS and Host still identify the original domain.
    const request = https.get(
      {
        hostname: address,
        servername: url.hostname,
        path: url.pathname + url.search,
        rejectUnauthorized: true,
        agent: false,
        signal,
        headers: {
          Host: url.hostname,
          Accept: IMAGE_MIME_TYPES.join(', '),
          'Accept-Encoding': 'identity',
          'User-Agent': 'Miter/1.0 (Local project image importer)',
        },
      },
      resolve,
    );
    request.once('error', reject);
  });
}

async function readImage(response: IncomingMessage): Promise<Buffer> {
  const contentType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (
    contentType &&
    contentType !== 'application/octet-stream' &&
    !IMAGE_MIME_TYPES.some((mime) => mime === contentType)
  ) {
    throw new Error('The URL did not return an image. Use a direct PNG, JPEG, WebP, or GIF link.');
  }
  if (Number(response.headers['content-length']) > MAX_IMAGE_BYTES) {
    throw new Error('The image exceeds the 5 MiB limit. Choose a smaller image.');
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error('The image source returned unexpected data.');
    }
    bytes += chunk.length;
    if (bytes > MAX_IMAGE_BYTES) {
      throw new Error('The image exceeds the 5 MiB limit. Choose a smaller image.');
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks, bytes);
  const detected = imageMime(body);
  if (!detected || (contentType && contentType !== 'application/octet-stream' && contentType !== detected)) {
    throw new Error('The URL did not return a supported raster image. Choose another image URL.');
  }
  return body;
}

export async function downloadPublicImage(url: string, signal: AbortSignal): Promise<Buffer> {
  const deadline = AbortSignal.timeout(20_000);
  const boundedSignal = AbortSignal.any([signal, deadline]);
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  const cancelLookup = () => resolver.cancel();
  boundedSignal.addEventListener('abort', cancelLookup, { once: true });

  try {
    let current = publicUrl(url);
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      boundedSignal.throwIfAborted();
      let addresses: string[];
      try {
        addresses = await resolver.resolve4(`${current.hostname}.`);
      } catch (cause) {
        boundedSignal.throwIfAborted();
        throw new Error('The image host did not resolve to a public IPv4 address. Choose another URL.', {
          cause,
        });
      }
      const [address] = addresses;
      if (!address || !addresses.every(publicAddress)) {
        throw new Error('The image host resolved to a private or reserved address. Choose a public URL.');
      }

      let response: IncomingMessage;
      try {
        response = await requestImage(current, address, boundedSignal);
      } catch (cause) {
        boundedSignal.throwIfAborted();
        throw new Error('Could not connect to the image host. Try another public image URL.', { cause });
      }

      try {
        const { statusCode, headers } = response;
        if (statusCode === 200) {
          return await readImage(response);
        }
        if (statusCode && redirectStatuses.has(statusCode) && headers.location) {
          current = publicUrl(headers.location, current);
          continue;
        }
        throw new Error(`The image host returned HTTP ${statusCode ?? 'unknown'}. Try another image URL.`);
      } finally {
        response.destroy();
      }
    }
    throw new Error('The image URL redirected too many times. Use a direct link.');
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.aborted) {
      throw new Error('The image download timed out. Try a direct URL for a smaller file.', { cause: error });
    }
    throw error;
  } finally {
    boundedSignal.removeEventListener('abort', cancelLookup);
  }
}
