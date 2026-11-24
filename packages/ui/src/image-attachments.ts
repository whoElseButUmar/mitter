import {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  imageAttachmentSchema,
} from '../../protocol/src/schemas/image-attachments.js';
import { textElement } from './dom/elements.js';
import {
  readImageDraft,
  writeImageDraft,
  type AttachmentDraft,
  type DraftAttempt,
  type SavedImage,
} from './image-attachment-store.js';

type DraftScope = {
  key: string;
  text: string;
  touched: boolean;
  blocked: boolean;
  draft: AttachmentDraft | undefined;
  images: SavedImage[];
  work: Promise<void>;
  busy: number;
  pending: number;
};

async function imageFile(file: File): Promise<SavedImage> {
  const reference = imageAttachmentSchema.safeParse({
    id: crypto.randomUUID(),
    name: file.name.trim() || 'Screenshot',
    type: file.type,
    size: file.size,
  });
  if (!reference.success) {
    throw new Error('Choose a PNG, JPEG, WebP or GIF image up to ' + MAX_IMAGE_BYTES / 1024 ** 2 + ' MiB.');
  }

  // Decode first so a renamed non-image cannot be attached or previewed.
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      bitmap.close();
    } catch {
      throw new Error('This image could not be opened. Try another file.');
    }
  }
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { reference: reference.data, blob: file, retained: false, digest };
}

export function mountImageAttachments(
  root: HTMLElement,
  input: HTMLTextAreaElement,
  changed: () => void,
  actions = root,
) {
  const document = root.ownerDocument;
  const supported = typeof indexedDB !== 'undefined';
  const list = document.createElement('ul');
  list.className = 'attachment-previews';
  list.setAttribute('aria-label', 'Attached images');
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = IMAGE_MIME_TYPES.join(',');
  picker.multiple = true;
  picker.hidden = true;
  const attach = textElement(document, 'button', 'Attach images', 'attach-images');
  attach.type = 'button';
  const status = textElement(document, 'p', '', 'attachment-status');
  status.setAttribute('role', 'status');
  root.append(picker, list, status);
  actions.append(attach);
  let disabled = false;
  let canSendImages = true;
  let scope: DraftScope | undefined;
  let restoring = false;
  let previews: { url: string; remove: HTMLButtonElement }[] = [];

  function renderControls(): void {
    root.hidden = !supported || (!scope?.images.length && !status.textContent && actions !== root);
    attach.hidden = !supported || !canSendImages;
    attach.disabled =
      disabled || !scope || scope.busy > 0 || scope.blocked || scope.images.length >= MAX_IMAGE_ATTACHMENTS;
    status.hidden = !status.textContent;
    root.setAttribute('aria-busy', String(!!scope?.pending));
    for (const { remove } of previews) {
      remove.disabled = disabled || !!scope?.busy || !!scope?.blocked;
    }
  }

  function renderPreviews(): void {
    for (const { url } of previews) {
      URL.revokeObjectURL(url);
    }
    previews = [];
    list.replaceChildren();
    for (const image of scope?.images ?? []) {
      const url = URL.createObjectURL(image.blob);
      const preview = document.createElement('img');
      preview.src = url;
      preview.alt = '';
      const item = document.createElement('li');
      const name = textElement(document, 'span', image.reference.name, 'attachment-name');
      name.title = image.reference.name;
      const remove = textElement(document, 'button', 'Remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove ' + image.reference.name);
      remove.onclick = () => removeImage(image);
      previews.push({ url, remove });
      item.append(preview, name, remove);
      list.append(item);
    }
    list.hidden = previews.length === 0;
    renderControls();
  }

  function show(text: string): void {
    status.textContent = text;
    renderControls();
  }

  function sync(): void {
    renderControls();
    changed();
  }

  // Keep transactions ordered per scope. A completion from a closed or
  // replaced composer can finish saving that draft without changing this UI.
  function run(current: DraftScope, task: () => Promise<void>, blocking = false): Promise<void> {
    current.pending++;
    if (blocking) {
      current.busy++;
    }
    if (scope === current) {
      if (blocking) {
        sync();
      } else {
        renderControls();
      }
    }
    const work = current.work.then(task);
    current.work = work
      .catch((error: unknown) => {
        if (scope === current) {
          if (error instanceof DOMException && error.name === 'QuotaExceededError') {
            show('Image storage is full. Remove an image from an unsent draft and try again.');
          } else if (error instanceof Error) {
            show(error.message);
          } else {
            show('Miter could not save the image draft.');
          }
        }
      })
      .finally(() => {
        current.pending--;
        if (blocking) {
          current.busy--;
        }
        if (scope === current) {
          sync();
        }
      });
    return work;
  }

  async function save(
    current: DraftScope,
    images: SavedImage[],
    added: SavedImage[] = [],
    retain = false,
    attempt = current.draft?.attempt,
  ): Promise<void> {
    let draft: AttachmentDraft | undefined;
    if (images.length) {
      draft = {
        revision: crypto.randomUUID(),
        text: current.text,
        images: images.map(({ reference }) => reference),
        ...(attempt && { attempt }),
      };
    }
    await writeImageDraft(current.key, current.draft?.revision, draft, added, retain);
    current.draft = draft;
    current.images = images;
  }

  function setScope(key: string): void {
    if (!supported || scope?.key === key) {
      return;
    }
    if (scope?.images.length) {
      input.value = '';
    }
    const current: DraftScope = {
      key,
      text: input.value,
      touched: false,
      blocked: false,
      draft: undefined,
      images: [],
      work: Promise.resolve(),
      busy: 0,
      pending: 0,
    };
    scope = current;
    status.textContent = '';
    renderPreviews();
    void run(
      current,
      async () => {
        try {
          const saved = await readImageDraft(key);
          current.draft = saved.draft;
          current.images = saved.images;
          if (scope === current && saved.draft) {
            if (!current.touched) {
              current.text = saved.draft.text;
            }
            input.value = current.text;
            restoring = true;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            restoring = false;
          }
        } catch (error) {
          current.blocked = true;
          throw error;
        }
        if (scope === current) {
          if (!canSendImages && current.images.length) {
            show('Remove the images to send this draft to a local coding model.');
          }
          renderPreviews();
        }
      },
      true,
    ).catch(() => {});
  }

  function attachFiles(files: File[]): void {
    const current = scope;
    if (!current || disabled || !files.length || current.blocked || current.busy) {
      return;
    }
    if (!canSendImages) {
      show('Images are available for ChatGPT tasks.');
      return;
    }
    show('');
    void run(
      current,
      async () => {
        const added: SavedImage[] = [];
        const digests = new Set(current.images.map(({ digest }) => digest));
        let notice = '';
        for (const file of files) {
          if (current.images.length + added.length >= MAX_IMAGE_ATTACHMENTS) {
            notice = 'Attach up to ' + MAX_IMAGE_ATTACHMENTS + ' images.';
            break;
          }
          try {
            const image = await imageFile(file);
            if (!digests.has(image.digest)) {
              digests.add(image.digest);
              added.push(image);
            }
          } catch (error) {
            if (error instanceof Error) {
              notice = error.message;
            }
          }
        }
        if (added.length) {
          await save(current, [...current.images, ...added], added);
        } else if (!notice) {
          notice = 'This image is already attached.';
        }
        if (scope === current) {
          show(notice);
          renderPreviews();
        }
      },
      true,
    ).catch(() => {});
  }

  function removeImage(image: SavedImage): void {
    const current = scope;
    if (!current || disabled || current.blocked || current.busy) {
      return;
    }
    const focused = document.activeElement?.closest('.attachment-previews');
    const index = current.images.indexOf(image);
    void run(
      current,
      async () => {
        await save(
          current,
          current.images.filter((candidate) => candidate !== image),
        );
        if (scope === current) {
          if (!current.images.length || canSendImages) {
            show('');
          }
          renderPreviews();
        }
      },
      true,
    ).catch(() => {});
    if (focused) {
      void current.work.then(() => {
        if (scope === current) {
          let target = previews[index]?.remove ?? previews.at(-1)?.remove;
          if (!target && !attach.hidden) {
            target = attach;
          }
          (target ?? input).focus();
        }
      });
    }
  }

  const inputChanged = () => {
    const current = scope;
    if (!current || restoring || current.blocked) {
      return;
    }
    current.text = input.value;
    current.touched = true;
    if (current.images.length || current.busy) {
      void run(current, async () => {
        if (current.images.length && current.draft?.text !== current.text) {
          await save(current, current.images);
        }
      }).catch(() => {});
    }
  };
  const paste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (files.length) {
      if (!event.clipboardData?.getData('text/plain')) {
        event.preventDefault();
      }
      attachFiles(files);
    }
  };
  const picked = () => {
    const files = Array.from(picker.files ?? []);
    picker.value = '';
    attachFiles(files);
  };
  picker.addEventListener('change', picked);
  input.addEventListener('paste', paste);
  input.addEventListener('input', inputChanged);
  attach.onclick = () => picker.click();
  renderPreviews();

  return {
    trigger: attach,
    setScope,
    get busy() {
      return !!scope?.busy || !!scope?.blocked;
    },
    get hasImages() {
      return !!scope?.images.length;
    },
    setAvailability(available: boolean, locked: boolean) {
      disabled = locked;
      if (canSendImages !== available) {
        canSendImages = available;
        if (available) {
          show('');
        } else if (scope?.images.length) {
          show('Remove the images to send this draft to a local coding model.');
        }
      }
      renderControls();
    },
    submission() {
      const current = scope;
      if (!current?.images.length) {
        return undefined;
      }
      return {
        images: current.images.map(({ reference }) => reference),
        previousAttempt: current.draft?.attempt,
        reserve: (attempt?: DraftAttempt) =>
          run(current, () => save(current, current.images, [], true, attempt)),
        confirm: async () => {
          await run(current, async () => {
            await save(current, []);
            if (scope === current) {
              renderPreviews();
            }
          }).catch(() => {});
        },
      };
    },
    dispose() {
      scope = undefined;
      input.removeEventListener('paste', paste);
      input.removeEventListener('input', inputChanged);
      picker.removeEventListener('change', picked);
      attach.onclick = null;
      attach.remove();
      renderPreviews();
      root.replaceChildren();
    },
  };
}
