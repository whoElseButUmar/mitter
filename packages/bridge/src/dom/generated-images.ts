import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
} from '../../../protocol/src/schemas/image-attachments.js';
import { matchesReceipt, type OutboundReceipt } from '../message-wire.js';
import { generationActive, htmlElements } from './page-elements.js';
import {
  discoverMessages,
  explicitRole,
  messageIdentity,
  messageRole,
  roleSelector,
  transcriptExcluded,
} from './transcript-discovery.js';
import { readUserMessageVariants } from './user-reader.js';
import type { GeneratedImage } from './types.js';

export function generatedImageSource(rawSource: string, pageOrigin: string): URL | undefined {
  let source: URL;
  try {
    source = new URL(rawSource, pageOrigin);
  } catch {
    return;
  }
  if (source.protocol !== 'https:' || source.username || source.password || source.hash) {
    return;
  }
  if (source.origin === pageOrigin && source.pathname === '/backend-api/estuary/content') {
    const ids = source.searchParams.getAll('id');
    if (ids.length === 1 && /^file[_-][A-Za-z0-9_-]{8,192}$/.test(ids[0] || '')) {
      return source;
    }
  }
  if (source.origin === 'https://files.oaiusercontent.com' && source.pathname !== '/') {
    return source;
  }
  return;
}

type ImageCandidate = { element: HTMLImageElement; source: URL };

function visibleGeneratedImages(messages: HTMLElement[], user: HTMLElement): ImageCandidate[] {
  const userIndex = messages.indexOf(user);
  if (userIndex === -1) {
    return [];
  }
  const images = new Map<string, ImageCandidate>();
  for (const message of messages.slice(userIndex + 1)) {
    if (messageRole(message) !== 'assistant') {
      break;
    }
    const nestedUsers = htmlElements(message, roleSelector).filter(
      (element) => explicitRole(element) === 'user',
    );
    for (const image of htmlElements(message, 'img')) {
      if (
        !(image instanceof HTMLImageElement) ||
        !image.isConnected ||
        image.closest('blockquote,[aria-hidden="true"]') ||
        transcriptExcluded(image) ||
        nestedUsers.some((element) => element.contains(image))
      ) {
        continue;
      }
      const rawSource = image.currentSrc || image.getAttribute('src');
      const source = rawSource && generatedImageSource(rawSource, location.origin);
      if (!source) {
        continue;
      }
      const identity = source.searchParams.get('id') || source.pathname;
      const key = source.origin + '/' + identity;
      if (!images.has(key)) {
        images.set(key, { element: image, source });
        if (images.size === MAX_IMAGE_ATTACHMENTS) {
          return Array.from(images.values());
        }
      }
    }
  }
  return Array.from(images.values());
}

export async function downloadGeneratedImage(
  source: URL,
  pageOrigin: string,
  checkSession: () => void,
): Promise<GeneratedImage | undefined> {
  const options: RequestInit = {
    mode: 'cors',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(12000),
  };
  if (source.origin === pageOrigin) {
    options.mode = 'same-origin';
    options.credentials = 'same-origin';
  }
  let response: Response;
  try {
    response = await fetch(source, options);
  } catch {
    checkSession();
    return;
  }
  const contentType = IMAGE_MIME_TYPES.find(
    (type) => type === response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase(),
  );
  const length = response.headers.get('content-length');
  if (
    !response.ok ||
    response.redirected ||
    (response.url && response.url !== source.href) ||
    !contentType ||
    !response.body ||
    (length && Number(length) > MAX_IMAGE_BYTES)
  ) {
    await response.body?.cancel().catch(() => {});
    checkSession();
    return;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      checkSession();
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        checkSession();
        return;
      }
      if (result.done) {
        complete = true;
        break;
      }
      size += result.value.length;
      if (size > MAX_IMAGE_BYTES) {
        return;
      }
      chunks.push(result.value);
    }
  } finally {
    if (!complete) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
  checkSession();
  if (!size) {
    return;
  }
  let binary = '';
  for (const chunk of chunks) {
    for (let offset = 0; offset < chunk.length; offset += 8192) {
      binary += String.fromCharCode(...chunk.subarray(offset, offset + 8192));
    }
  }
  return { base64: btoa(binary), contentType };
}

async function generatedImageOwner(
  receipt: OutboundReceipt,
  discovery: ReturnType<typeof discoverMessages>,
  checkSession: () => void,
): Promise<HTMLElement | undefined> {
  const exchangeId = receipt.exchangeId;
  if (discovery.stats.scanLimited || !exchangeId) {
    return;
  }
  const candidateUsers = discovery.messages.filter(
    (message) => messageRole(message) === 'user' && message.textContent?.includes(exchangeId),
  );
  if (!candidateUsers.some((candidate) => visibleGeneratedImages(discovery.messages, candidate).length)) {
    return;
  }

  const matches: HTMLElement[] = [];
  for (const message of candidateUsers) {
    const originalText = message.textContent;
    const { texts } = readUserMessageVariants(message);
    for (const candidate of texts) {
      const verified = await matchesReceipt(candidate, receipt);
      checkSession();
      if (verified && message.isConnected && message.textContent === originalText) {
        matches.push(message);
        break;
      }
    }
  }
  const owner = matches[0];
  if (
    matches.length === 1 &&
    owner &&
    (!receipt.acknowledgedUserId || messageIdentity(owner) === receipt.acknowledgedUserId)
  ) {
    return owner;
  }
  return;
}

export async function observeGeneratedImageCount(
  receipt: OutboundReceipt,
  discovery: ReturnType<typeof discoverMessages>,
  checkSession: () => void,
): Promise<number | undefined> {
  const owner = await generatedImageOwner(receipt, discovery, checkSession);
  if (owner && !generationActive()) {
    const fresh = discoverMessages();
    const lastUser = fresh.messages.findLast((message) => messageRole(message) === 'user');
    if (!fresh.stats.scanLimited && !fresh.stats.unclassifiedTail && owner === lastUser) {
      return visibleGeneratedImages(fresh.messages, owner).length || undefined;
    }
  }
  return;
}

export async function captureGeneratedImage(
  receipt: OutboundReceipt,
  index: number,
  checkSession: () => void,
): Promise<{ generatedImage: GeneratedImage } | { generatedImageIssue: 'missing' | 'unavailable' }> {
  const discovery = discoverMessages();
  if (discovery.stats.scanLimited || generationActive()) {
    return { generatedImageIssue: 'unavailable' };
  }
  const owner = await generatedImageOwner(receipt, discovery, checkSession);
  if (!owner) {
    return { generatedImageIssue: 'missing' };
  }

  const ownerText = owner.textContent;
  const selectedImage = (): ImageCandidate | undefined => {
    const fresh = discoverMessages();
    if (
      !fresh.stats.scanLimited &&
      !generationActive() &&
      owner.isConnected &&
      owner.textContent === ownerText
    ) {
      return visibleGeneratedImages(fresh.messages, owner)[index - 1];
    }
    return;
  };

  const selected = selectedImage();
  if (!selected) {
    return { generatedImageIssue: 'missing' };
  }
  const generatedImage = await downloadGeneratedImage(selected.source, location.origin, checkSession);
  checkSession();
  const current = selectedImage();
  if (
    !generatedImage ||
    current?.element !== selected.element ||
    current.source.href !== selected.source.href
  ) {
    return { generatedImageIssue: 'unavailable' };
  }
  return { generatedImage };
}
