import {parseReceipt,type OutboundReceipt} from './message-wire.js';
/** Resume metadata only. No prompts, replies, credentials or execution grants
 * are stored here. A restored link is paused until the user clicks Resume. */
export interface ChatLink {
  id: number;
  url: string;
  title: string;
  newChat: boolean;
  bindingPending?: boolean;
  projectId?: string;
  updatedAt?: number;
  maxTurns?: number;
  maxMinutes?: number;
  lastReceipt?:OutboundReceipt;
}
export interface LinkStorage {
  get(key: string): Promise<Record<string, any>>;
  set(value: Record<string, unknown>): Promise<unknown>;
}
export const LINK_STORAGE_KEY = 'mitterChatLinksV2';
export function linkURL(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (!['https://chatgpt.com', 'https://chat.openai.com'].includes(u.origin)) return;
    if (u.pathname !== '/' && !/^\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]+\/?$/.test(u.pathname)) return;
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch { return; }
}
export function parseChatLinks(value: unknown): Map<string, ChatLink> {
  const result = new Map<string, ChatLink>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [workerId, item] of Object.entries(value).slice(0, 64)) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(workerId) || !item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    if (!Number.isSafeInteger(v.id) || (v.id as number) < 0 || typeof v.url !== 'string') continue;
    const url = linkURL(v.url); if (!url) continue;
    const link: ChatLink = {id: v.id as number, url, title: typeof v.title === 'string' ? v.title.slice(0, 200) : 'Task conversation', newChat: !/\/c\//.test(url)};
    if (v.bindingPending === true) link.bindingPending = true;
    if (typeof v.projectId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v.projectId)) link.projectId = v.projectId;
    if (typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt)) link.updatedAt = v.updatedAt;
    if (Number.isInteger(v.maxTurns) && Number(v.maxTurns) >= 1 && Number(v.maxTurns) <= 20) link.maxTurns = Number(v.maxTurns);
    if (Number.isInteger(v.maxMinutes) && Number(v.maxMinutes) >= 1 && Number(v.maxMinutes) <= 60) link.maxMinutes = Number(v.maxMinutes);
    const receipt=parseReceipt(v.lastReceipt);if(receipt&&receipt.workerId===workerId&&receipt.projectId===link.projectId)link.lastReceipt=receipt;
    result.set(workerId, link);
  }
  return result;
}
export class ChatLinkStore {
  readonly ready: Promise<void>;
  private stopped=false;
  private values = new Map<string, ChatLink>();
  private writing: Promise<unknown> = Promise.resolve();
  private lastSaved = '';
  private lastWriteError:unknown;
  constructor(private local: LinkStorage, legacy?: LinkStorage, private warn: (message: string) => void = () => {}) {
    this.ready = (async () => {
      try {
        const data = await local.get(LINK_STORAGE_KEY);
        const record = data[LINK_STORAGE_KEY];
        if (record?.version === 2) this.values = new Map([...parseChatLinks(record.links), ...this.values]);
        else if (legacy) {
          const old = await legacy.get('mitterChatLinks');
          this.values = new Map([...parseChatLinks(old.mitterChatLinks), ...this.values]);
        }
      } catch (error) { this.warn('Resume history could not be read: ' + String(error)); }
    })();
  }
  get(id: string): ChatLink | undefined { const item = this.values.get(id); return item ? structuredClone(item) : undefined; }
  entries(): Array<[string, ChatLink]> { return [...this.values].map(([id, value]) => [id, structuredClone(value)]); }
  set(id: string, link: ChatLink): void {
    if(this.stopped)return;
    const item = parseChatLinks({[id]: link}).get(id);
    if (!item) throw new Error('Invalid task conversation link.');
    this.values.set(id, item);
    while (this.values.size > 64) this.values.delete(this.values.keys().next().value!);
    this.persist();
  }
  delete(id: string): void { if (this.values.delete(id)) this.persist(); }
  async quiesce():Promise<void>{this.stopped=true;await this.flush();this.values.clear();this.lastSaved='';}
  private persist(): void {
    if(this.stopped)return;
    // Serialize writes. An older, slower save must not overwrite a newly bound URL.
    this.writing = this.writing.then(async () => {
      await this.ready;
      const json = JSON.stringify({version: 2, links: Object.fromEntries(this.values)});
      if (json === this.lastSaved) return;
      await this.local.set({[LINK_STORAGE_KEY]: JSON.parse(json)});
      this.lastSaved = json;this.lastWriteError=undefined;
    }).catch(error => {this.lastWriteError=error;this.warn('Resume history could not be saved: ' + String(error));});
  }
  async flush(requireSaved=false): Promise<void> { await this.ready; await this.writing; if(requireSaved&&this.lastWriteError)throw this.lastWriteError; }
}
