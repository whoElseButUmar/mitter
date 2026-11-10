import { z } from 'zod';
import { outboundReceiptSchema, parseReceipt } from './message-wire.js';
import { identifierSchema, nonNegativeIntegerSchema } from './schemas/primitives.js';
import { isRecord } from '../../protocol/src/schemas/primitives.js';

/** Resume metadata only. No prompts, replies, credentials or execution grants
 * are stored here. A restored link is paused until the user clicks Resume. */
export const chatLinkSchema = z
  .object({
    id: nonNegativeIntegerSchema.describe('The browser tab linked to this task.'),
    url: z
      .string()
      .refine((url) => linkURL(url) !== undefined)
      .describe('The address of a ChatGPT chat supported by Miter.'),
    title: z.string().max(200).describe('The conversation name shown to the user.'),
    newChat: z.boolean().describe('Whether this chat is a new conversation.'),
    bindingPending: z
      .boolean()
      .optional()
      .describe('Whether Miter is waiting for this chat to get its own conversation address.'),
    projectId: identifierSchema.optional().describe('The project that owns the linked task.'),
    updatedAt: z
      .number()
      .optional()
      .describe('When this link was last updated, in milliseconds since the Unix epoch.'),
    maxTurns: z.int().min(1).max(20).optional().describe('The most turns this task may send.'),
    maxMinutes: z.int().min(1).max(60).optional().describe('The most minutes this task may run.'),
    lastReceipt: outboundReceiptSchema
      .optional()
      .describe('Saved proof of the most recent message sent for this task.'),
  })
  .describe('The saved chat destination used when resuming a task.');

export type ChatLink = z.infer<typeof chatLinkSchema>;

export type LinkStorage = {
  get(key: string): Promise<unknown>;
  set(value: Record<string, unknown>): Promise<unknown>;
};

const storedLinksSchema = z
  .object({
    version: z.literal(2).describe('The current saved chat-link format version.'),
    links: z.record(identifierSchema, chatLinkSchema).describe('Saved chat destinations keyed by worker ID.'),
  })
  .describe('Chat links saved by task ID.');

const legacyChatLinkSchema = chatLinkSchema
  .omit({ newChat: true })
  .extend({
    url: chatLinkSchema.shape.url
      .transform((url) => linkURL(url) ?? url)
      .describe('The supported legacy destination normalized to its origin and path.'),
    title: z
      .string()
      .transform((title) => title.slice(0, 200))
      .catch('Task conversation')
      .describe(
        'Legacy display title clipped to 200 UTF-16 code units, with a fallback when absent or invalid.',
      ),
    bindingPending: z
      .literal(true)
      .optional()
      .catch(undefined)
      .describe('Only a legacy true flag preserves pending conversation binding.'),
    projectId: chatLinkSchema.shape.projectId
      .catch(undefined)
      .describe('A valid legacy project ID, with malformed hints discarded.'),
    updatedAt: chatLinkSchema.shape.updatedAt
      .catch(undefined)
      .describe('Finite legacy Unix milliseconds; invalid hints are discarded, including non-numbers.'),
    maxTurns: chatLinkSchema.shape.maxTurns
      .catch(undefined)
      .describe('A legacy turn limit from one to twenty, with invalid hints discarded.'),
    maxMinutes: chatLinkSchema.shape.maxMinutes
      .catch(undefined)
      .describe('A legacy time limit from one to sixty minutes, with invalid hints discarded.'),
    lastReceipt: z
      .preprocess(parseReceipt, outboundReceiptSchema.optional())
      .describe('A migrated legacy receipt, retained only when it also matches the map worker and project.'),
  })
  .transform((record): ChatLink => {
    const link: ChatLink = { ...record, newChat: !/\/c\//.test(record.url) };
    for (const field of [
      'bindingPending',
      'projectId',
      'updatedAt',
      'maxTurns',
      'maxMinutes',
      'lastReceipt',
    ] as const) {
      if (link[field] === undefined) {
        delete link[field];
      }
    }
    return link;
  })
  .describe('Legacy destination metadata with explicit defaults and invalid optional hints discarded.');

function firstSavedLinks(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .slice(0, 64)
      .map((key) => [key, value[key]]),
  );
}

const legacyLinkRecordSchema = z
  .preprocess(firstSavedLinks, z.record(z.string(), legacyChatLinkSchema.optional().catch(undefined)))
  .describe('Legacy chat history; an invalid destination is discarded without losing valid neighbors.');

const savedChatLinksSchema = storedLinksSchema
  .extend({
    links: legacyLinkRecordSchema
      .optional()
      .catch(undefined)
      .describe('Legacy version-two destinations; absent or malformed history means no restored links.'),
  })
  .describe('Version-two chat history with the established legacy metadata migration.');

export const LINK_STORAGE_KEY = 'mitterChatLinksV2';

const linkStorageReadSchema = z
  .object({
    [LINK_STORAGE_KEY]: savedChatLinksSchema
      .optional()
      .describe('Version-two resume history, absent before any destination was saved.'),
  })
  .describe('The browser storage reply containing version-two resume history when present.');
const legacyLinkStorageReadSchema = z
  .object({
    mitterChatLinks: legacyLinkRecordSchema
      .optional()
      .catch(undefined)
      .describe('Unversioned history from older releases, absent when no destinations were saved.'),
  })
  .describe('The legacy browser storage reply containing unversioned resume history when present.');

export function linkURL(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!['https://chatgpt.com', 'https://chat.openai.com'].includes(url.origin)) {
      return;
    }
    if (url.pathname !== '/' && !/^\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]+\/?$/.test(url.pathname)) {
      return;
    }
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch {
    return;
  }
}

function bindSavedLinks(history: z.infer<typeof legacyLinkRecordSchema>): Map<string, ChatLink> {
  const links = new Map<string, ChatLink>();
  for (const [workerId, link] of Object.entries(history)) {
    if (!link || !identifierSchema.safeParse(workerId).success) {
      continue;
    }
    const receipt = link.lastReceipt;
    if (receipt && (receipt.workerId !== workerId || receipt.projectId !== link.projectId)) {
      delete link.lastReceipt;
    }
    links.set(workerId, link);
  }
  return links;
}

export function parseChatLinks(value: unknown): Map<string, ChatLink> {
  const history = legacyLinkRecordSchema.safeParse(value);
  if (!history.success) {
    return new Map();
  }
  return bindSavedLinks(history.data);
}

export class ChatLinkStore {
  readonly ready: Promise<void>;
  private stopped = false;
  private values = new Map<string, ChatLink>();
  private writing: Promise<unknown> = Promise.resolve();
  private lastSaved = '';
  private lastWriteError: unknown;

  constructor(
    private local: LinkStorage,
    legacy?: LinkStorage,
    private warn: (message: string) => void = () => {},
  ) {
    this.ready = this.loadLinks(legacy);
  }

  private async loadLinks(legacy?: LinkStorage): Promise<void> {
    try {
      const stored = linkStorageReadSchema.safeParse(await this.local.get(LINK_STORAGE_KEY));
      if (stored.success && stored.data[LINK_STORAGE_KEY] !== undefined) {
        this.values = new Map([...bindSavedLinks(stored.data[LINK_STORAGE_KEY].links ?? {}), ...this.values]);
      } else if (legacy) {
        const migrated = legacyLinkStorageReadSchema.safeParse(await legacy.get('mitterChatLinks'));
        if (!migrated.success) {
          throw new Error('Invalid legacy chat-link storage. Resume history was not restored.', {
            cause: migrated.error,
          });
        }
        this.values = new Map([...bindSavedLinks(migrated.data.mitterChatLinks ?? {}), ...this.values]);
      } else if (!stored.success) {
        throw new Error('Invalid chat-link storage. Resume history was not restored.', {
          cause: stored.error,
        });
      }
    } catch (error) {
      this.warn('Resume history could not be read: ' + String(error));
    }
  }

  get(workerId: string): ChatLink | undefined {
    const link = this.values.get(workerId);
    if (!link) {
      return;
    }

    return structuredClone(link);
  }

  entries(): Array<[string, ChatLink]> {
    return [...this.values].map(([workerId, link]) => [workerId, structuredClone(link)]);
  }

  set(workerId: string, link: ChatLink): void {
    if (this.stopped) {
      return;
    }

    const parsedLink = parseChatLinks({ [workerId]: link }).get(workerId);
    if (!parsedLink) {
      throw new Error('Invalid task conversation link.');
    }
    this.values.set(workerId, parsedLink);

    while (this.values.size > 64) {
      const oldestWorkerId = this.values.keys().next().value;
      if (oldestWorkerId === undefined) {
        break;
      }
      this.values.delete(oldestWorkerId);
    }
    this.persist();
  }

  delete(workerId: string): void {
    if (this.values.delete(workerId)) {
      this.persist();
    }
  }

  async quiesce(): Promise<void> {
    this.stopped = true;
    await this.flush();

    this.values.clear();
    this.lastSaved = '';
  }

  private persist(): void {
    if (this.stopped) {
      return;
    }
    // Serialize writes. An older, slower save must not overwrite a newly bound URL.
    this.writing = this.writing
      .then(async () => {
        await this.ready;

        const snapshot = storedLinksSchema.parse({
          version: 2,
          links: Object.fromEntries(this.values),
        });
        const json = JSON.stringify(snapshot);
        if (json === this.lastSaved) {
          return;
        }

        await this.local.set({ [LINK_STORAGE_KEY]: snapshot });
        this.lastSaved = json;
        this.lastWriteError = undefined;
      })
      .catch((error) => {
        this.lastWriteError = error;
        this.warn('Resume history could not be saved: ' + String(error));
      });
  }

  async flush(requireSaved = false): Promise<void> {
    await this.ready;
    await this.writing;
    if (requireSaved && this.lastWriteError) {
      throw this.lastWriteError;
    }
  }
}
