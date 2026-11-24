import { z } from 'zod';
import {
  imageAttachmentSchema,
  imageAttachmentsSchema,
  type ImageAttachment,
} from '../../protocol/src/schemas/image-attachments.js';

const databaseName = 'mitter-image-attachments';

const draftAttemptSchema = z
  .strictObject({
    id: z.uuid().describe('Idempotency ID assigned before submitting this follow-up.'),
    key: z.string().max(25000).describe('Exact submission kind, text and ordered image references.'),
  })
  .describe('Last attempted submission saved beside an image draft.');

const attachmentDraftSchema = z
  .strictObject({
    revision: z.uuid().describe('Revision used to protect against changes in another Miter tab.'),
    text: z.string().max(4000).describe('Unsent composer text.'),
    images: imageAttachmentsSchema,
    attempt: draftAttemptSchema.optional().describe('Submission ID to reuse if this exact draft is retried.'),
  })
  .describe('Saved composer draft and any attached image references.');

const savedImageSchema = z
  .strictObject({
    reference: imageAttachmentSchema,
    blob: z.lazy(() => z.instanceof(Blob)).describe('Original image bytes in this browser profile.'),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('SHA-256 of the exact image bytes.'),
    retained: z.boolean().describe('Whether a task or follow-up may already reference the image.'),
  })
  .describe('Locally stored image and retention state.');

export type DraftAttempt = z.infer<typeof draftAttemptSchema>;
export type AttachmentDraft = z.infer<typeof attachmentDraftSchema>;
export type SavedImage = z.infer<typeof savedImageSchema>;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('drafts');
      request.result.createObjectStore('images');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

function resultOf(request: IDBRequest<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withImages<T>(
  mode: IDBTransactionMode,
  run: (drafts: IDBObjectStore, images: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await database();
  try {
    const transaction = db.transaction(['drafts', 'images'], mode, { durability: 'strict' });
    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Image storage was interrupted.'));
    });

    try {
      const [result] = await Promise.all([
        run(transaction.objectStore('drafts'), transaction.objectStore('images')),
        committed,
      ]);
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The request may already have aborted the transaction.
      }
      await committed.catch(() => {});
      throw error;
    }
  } finally {
    db.close();
  }
}

async function getImage(store: IDBObjectStore, reference: ImageAttachment): Promise<SavedImage> {
  const stored = savedImageSchema.safeParse(await resultOf(store.get(reference.id)));
  if (
    !stored.success ||
    stored.data.reference.id !== reference.id ||
    stored.data.reference.name !== reference.name ||
    stored.data.reference.type !== reference.type ||
    stored.data.reference.size !== reference.size ||
    stored.data.blob.type !== reference.type ||
    stored.data.blob.size !== reference.size
  ) {
    throw new Error('An attached image is unavailable in this browser profile.');
  }
  return stored.data;
}

export async function readImageAttachment(reference: ImageAttachment): Promise<Blob> {
  const image = await withImages('readonly', async (_drafts, images) => getImage(images, reference));
  return image.blob;
}

export function readImageDraft(scope: string): Promise<{
  draft?: AttachmentDraft;
  images: SavedImage[];
}> {
  return withImages('readonly', async (drafts, images) => {
    const saved = await resultOf(drafts.get(scope));
    if (saved === undefined) {
      return { images: [] };
    }
    const draft = attachmentDraftSchema.parse(saved);
    return { draft, images: await Promise.all(draft.images.map((image) => getImage(images, image))) };
  });
}

/** Draft references and any new bytes are written together. A staged send pins
 * its images before the host can accept the request without a visible receipt. */
export function writeImageDraft(
  scope: string,
  expected: string | undefined,
  next: AttachmentDraft | undefined,
  added: SavedImage[],
  retain = false,
): Promise<void> {
  return withImages('readwrite', async (drafts, images) => {
    const saved = await resultOf(drafts.get(scope));
    let prior: AttachmentDraft | undefined;
    if (saved !== undefined) {
      prior = attachmentDraftSchema.parse(saved);
    }
    if (prior?.revision !== expected) {
      throw new Error('This draft changed in another Miter view. Reopen it to see the latest version.');
    }

    if (next) {
      const draft = attachmentDraftSchema.parse(next);
      for (const image of added) {
        images.add(savedImageSchema.parse(image), image.reference.id);
      }
      if (retain) {
        const referenced = await Promise.all(draft.images.map((image) => getImage(images, image)));
        for (const image of referenced) {
          images.put({ ...image, retained: true }, image.reference.id);
        }
      }
      drafts.put(draft, scope);
    } else {
      drafts.delete(scope);
    }

    const remaining = new Set(next?.images.map(({ id }) => id));
    for (const reference of prior?.images ?? []) {
      if (!remaining.has(reference.id)) {
        const removed = await getImage(images, reference);
        if (!removed.retained) {
          images.delete(reference.id);
        }
      }
    }
  });
}
