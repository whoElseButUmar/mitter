import type { ImageAttachment } from '../../../protocol/src/schemas/image-attachments.js';
import { contentHidden } from './page-elements.js';
import type { DomRequest, PreparedMessage } from './types.js';

const cardSelector = [
  '[data-testid="attachment-thumbnail"]',
  '[data-testid="file-thumbnail"]',
  '[data-testid="file-preview"]',
  '[data-testid="composer-attachment"]',
  'div[role="button"][aria-label]:has(img)',
].join(',');
const removeSelector = ['button[aria-label^="Remove " i]', 'button[data-testid="remove-attachment"]'].join(
  ',',
);
const filenameSelector = '[alt],[title],[aria-label],[data-file-name],[data-filename]';
const progressSelector = '[role="progressbar"],[aria-busy="true"],[data-uploading="true"],.animate-spin';
const uploadWaitMilliseconds = 30000;
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

type ComposerImage = {
  name: string | undefined;
  uploading: boolean;
  failed: boolean;
};

export function sameImageAttachments(
  first: ImageAttachment[] | undefined,
  second: ImageAttachment[] | undefined,
): boolean {
  const left = first ?? [];
  const right = second ?? [];
  return (
    left.length === right.length &&
    left.every((image, index) => {
      const other = right[index];
      return (
        other &&
        image.id === other.id &&
        image.name === other.name &&
        image.type === other.type &&
        image.size === other.size
      );
    })
  );
}

function failImageOperation(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function imageName(attachment: ImageAttachment, messageId: string): string {
  if (!/^[a-z0-9_-]{1,100}$/i.test(messageId)) {
    failImageOperation('INVALID_IMAGE', 'Miter could not verify the image’s send request.');
  }
  const prefix = 'miter-' + messageId + '-' + attachment.id + '-';
  const extension = '.' + extensions[attachment.type];
  const stem = attachment.name.replace(/\.[a-z0-9]{1,12}$/i, '').replace(/[<>:"|?*]/g, '-');
  const encoder = new TextEncoder();
  const maximumStemBytes = 255 - prefix.length - extension.length;
  let clippedStem = '';
  let stemBytes = 0;
  for (const character of stem) {
    stemBytes += encoder.encode(character).byteLength;
    if (stemBytes > maximumStemBytes) {
      break;
    }
    clippedStem += character;
  }
  return prefix + (clippedStem.trim() || 'image') + extension;
}

function visibleElements(root: ParentNode, selector: string): Element[] {
  return Array.from(root.querySelectorAll(selector)).filter((element) => !contentHidden(element));
}

function fileRemoveButtons(root: ParentNode): Element[] {
  return visibleElements(root, removeSelector).filter((button) => {
    const label = button.getAttribute('aria-label') ?? '';
    return (
      button.matches('[data-testid="remove-attachment"]') ||
      /^remove (?:file|image|attachment)(?:\s|$|:)/i.test(label) ||
      /\.[a-z0-9]{1,12}$/i.test(label)
    );
  });
}

// Read only the active form. A matching filename in a transcript or another
// editor does not prove that the current draft owns the image.
function composerImages(composer: HTMLElement, names: string[]): ComposerImage[] {
  const form = composer.closest('form');
  if (!form) {
    return [];
  }
  const cards = visibleElements(form, cardSelector);
  for (const remove of fileRemoveButtons(form)) {
    if (cards.some((card) => card.contains(remove))) {
      continue;
    }
    let card = remove.parentElement;
    while (card && card !== form && fileRemoveButtons(card).length === 1 && !card.contains(composer)) {
      if (card.querySelector('img,' + progressSelector) || cards.some((entry) => card?.contains(entry))) {
        cards.push(card);
        break;
      }
      card = card.parentElement;
    }
    if (!cards.some((entry) => entry.contains(remove))) {
      cards.push(remove);
    }
  }
  for (const image of visibleElements(form, 'img')) {
    if (!cards.some((card) => card.contains(image))) {
      cards.push(image);
    }
  }

  return cards
    .filter((card) => !cards.some((other) => other !== card && other.contains(card)))
    .map((card) => {
      const labeled = [card, ...visibleElements(card, filenameSelector)];
      const matchedNames = names.filter((name) =>
        labeled.some((element) => {
          const labels = [
            element.getAttribute('alt'),
            element.getAttribute('title'),
            element.getAttribute('data-file-name'),
            element.getAttribute('data-filename'),
            element
              .getAttribute('aria-label')
              ?.replace(/^remove\s+(?:(?:file|image|attachment)\s*:?\s*)?/i, ''),
          ];
          return labels.includes(name);
        }),
      );
      let name: string | undefined;
      if (matchedNames.length === 1) {
        name = matchedNames[0];
      }
      const namedPreview =
        name &&
        labeled.some(
          (element) =>
            (element.matches('img') && element.getAttribute('alt') === name) ||
            (element.getAttribute('role') === 'button' && element.getAttribute('aria-label') === name),
        );
      return {
        name,
        uploading:
          !namedPreview ||
          card.matches(progressSelector) ||
          visibleElements(card, progressSelector).length > 0,
        failed:
          card.matches('[aria-invalid="true"]') ||
          visibleElements(card, '[role="alert"],[aria-invalid="true"]').length > 0,
      };
    });
}

export function composerHasImages(composer: HTMLElement): boolean {
  return composerImages(composer, []).length > 0;
}

export function checkComposerImages(
  composer: HTMLElement,
  messageId: string,
  attachments: ImageAttachment[] | undefined,
  uploadInProgress = false,
): { complete: boolean; images: ComposerImage[] } {
  const names = (attachments ?? []).map((attachment) => imageName(attachment, messageId));
  const images = composerImages(composer, names);
  const observedNames = images.map((image) => image.name);
  if (images.some((image) => image.failed)) {
    failImageOperation(
      'IMAGE_UPLOAD_FAILED',
      'ChatGPT reported an upload error. Check the images in the linked chat.',
    );
  }
  if (
    new Set(observedNames.filter(Boolean)).size !== observedNames.filter(Boolean).length ||
    images.length > names.length ||
    (!uploadInProgress && observedNames.includes(undefined))
  ) {
    failImageOperation(
      'IMAGE_DRAFT_CONFLICT',
      'The linked chat has different images in its draft. Miter left them untouched.',
    );
  }
  return {
    complete: images.length === names.length && images.every((image) => image.name && !image.uploading),
    images,
  };
}

function imageBytes(base64: string, attachment: ImageAttachment): Uint8Array<ArrayBuffer> {
  if (base64.length !== 4 * Math.ceil(attachment.size / 3)) {
    failImageOperation('INVALID_IMAGE', 'The saved image is incomplete. Attach the image again.');
  }
  let decoded: string;
  try {
    decoded = atob(base64);
  } catch {
    failImageOperation('INVALID_IMAGE', 'The saved image could not be read. Attach the image again.');
  }
  const signatures = {
    'image/png': decoded.startsWith('\x89PNG\r\n\x1a\n'),
    'image/jpeg': decoded.startsWith('\xff\xd8\xff'),
    'image/gif': decoded.startsWith('GIF87a') || decoded.startsWith('GIF89a'),
    'image/webp': decoded.startsWith('RIFF') && decoded.slice(8, 12) === 'WEBP',
  };
  if (decoded.length !== attachment.size || !signatures[attachment.type]) {
    failImageOperation('INVALID_IMAGE', 'The saved file is not a supported image. Attach the image again.');
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function stageImage(composer: HTMLElement, file: File, recordAttempt: () => void): void {
  const form = composer.closest('form');
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const inputs = Array.from(form?.querySelectorAll('input[type="file"]') ?? []).filter(
    (input): input is HTMLInputElement =>
      input instanceof HTMLInputElement &&
      !input.disabled &&
      (input.id === 'upload-files' ||
        input.id === 'upload-photos' ||
        (input.multiple && input.getAttribute('aria-label') === 'Attach files') ||
        input.accept.includes('image/')),
  );
  const [input] = inputs;
  if (input && inputs.length === 1) {
    recordAttempt();
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return;
  }

  recordAttempt();
  composer.dispatchEvent(
    new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clipboardData: transfer,
    }),
  );
}

export function attachComposerImage(
  request: DomRequest,
  prepared: PreparedMessage,
  composer: HTMLElement,
  checkSession: () => void,
): 'attached' | 'uploading_images' | 'image_needed' {
  const image = request.image;
  const expected = request.imageAttachments?.find((attachment) => attachment.id === image?.attachment.id);
  if (!image || !expected || !sameImageAttachments([expected], [image.attachment])) {
    failImageOperation('INVALID_IMAGE', 'The selected image does not belong to this request.');
  }
  const name = imageName(expected, prepared.id);
  const uploads = (prepared.imageUploads ??= new Map());
  const attempt = uploads.get(expected.id);
  const { images } = checkComposerImages(
    composer,
    prepared.id,
    prepared.imageAttachments,
    !!attempt && !attempt.confirmed,
  );
  const shown = images.find((entry) => entry.name === name);
  if (shown && !shown.uploading) {
    uploads.set(expected.id, { startedAt: Date.now(), confirmed: true });
    return 'attached';
  }
  if (attempt?.confirmed) {
    failImageOperation(
      'IMAGE_DRAFT_CONFLICT',
      'An attachment changed in ChatGPT. Miter left the draft untouched.',
    );
  }
  if (attempt || shown) {
    const previous = attempt ?? { startedAt: Date.now(), confirmed: false };
    uploads.set(expected.id, previous);
    if (Date.now() - previous.startedAt >= uploadWaitMilliseconds) {
      failImageOperation(
        'IMAGE_UPLOAD_UNCONFIRMED',
        'ChatGPT did not confirm the image upload. Check the linked chat before resuming.',
      );
    }
    return 'uploading_images';
  }
  if (!image.base64) {
    return 'image_needed';
  }

  const bytes = imageBytes(image.base64, expected);
  const file = new File([bytes], name, { type: expected.type });
  checkSession();
  stageImage(composer, file, () => uploads.set(expected.id, { startedAt: Date.now(), confirmed: false }));
  return 'uploading_images';
}
