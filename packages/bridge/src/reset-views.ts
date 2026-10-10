/** Per-document write barrier. Sender.documentId is optional even for an
 * extension page. Missing IDs are NOT interchangeable, and a shared page URL
 * cannot prove that two side panels are the same document.
 *
 * If Chrome omits the port's document ID, challenge that authenticated port to
 * temporarily mark its own URL (history.replaceState, no navigation). Resolve
 * the unpredictable marker through Chrome's independent context inventory,
 * pin the returned context/document identity, then remove the marker. No
 * self-reported document ID, URL-only match or permission escalation is used.
 */
export const RESET_VIEW_PARAM = '__miter_reset_view';
export interface ResetViewContext { contextId?: string; documentId?: string; documentUrl?: string }
export interface ResetViewPort {
  sender?: {url?: string; documentId?: string};
  postMessage(message: unknown): void;
}
interface Proof { contextId?: string; documentId?: string }
interface Pending {
  id: string; promise: Promise<void>; resolve(): void; reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>; verifying: boolean;
}
const present = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const page = (url: string) => url.split(/[?#]/)[0];
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
export class ResetViewBarrier {
  private ports = new Set<ResetViewPort>();
  private pending = new Map<ResetViewPort, Pending>();
  private proofs = new Map<ResetViewPort, Proof>();
  private revision = 0;
  constructor(private urls: readonly string[], private contexts: () => Promise<ResetViewContext[]>, private timeoutMs = 15000) {}
  add(port: ResetViewPort): void { this.ports.add(port); this.revision++; }
  remove(port: ResetViewPort): void {
    this.ports.delete(port); this.proofs.delete(port); this.revision++;
    this.pending.get(port)?.reject(Error('A Miter view disconnected before confirming cleanup. Reopen Miter and retry the reset.'));
  }
  dispose(): void { for (const port of [...this.ports]) this.remove(port); }
  quiesce(port: ResetViewPort): Promise<void> {
    if (!this.ports.has(port)) return Promise.reject(Error('The Miter view is no longer connected.'));
    const pending = this.pending.get(port); if (pending) return pending.promise;
    if (this.proofs.has(port)) return Promise.resolve();
    const id = crypto.randomUUID(); let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => reject(Error('Open Miter view did not acknowledge reset: ' + (port.sender?.url || 'unknown view') + '. Close that view and retry.')), this.timeoutMs);
    const job: Pending = {id, promise, resolve, reject, timer, verifying: false};
    this.pending.set(port, job);
    void promise.finally(() => { clearTimeout(timer); if (this.pending.get(port) === job) this.pending.delete(port); }).catch(() => {});
    try { port.postMessage({type: 'reset-quiesce', id, identify: !present(port.sender?.documentId)}); }
    catch (error) { reject(Error('Could not contact Miter view: ' + detail(error))); }
    return promise;
  }
  receive(port: ResetViewPort, message: unknown): boolean {
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'reset-ack') return false;
    const job = this.pending.get(port);
    if (!job || !('id' in message) || typeof message.id !== 'string' || message.id !== job.id || job.verifying) return true;
    job.verifying = true;
    if (!('ok' in message) || message.ok !== true) {
      const error = 'error' in message && typeof message.error === 'string' ? message.error.slice(0, 2000) : 'The view did not confirm data cleanup.';
      job.reject(Error((port.sender?.url || 'Miter view') + ': ' + error)); return true;
    }
    void this.identify(port, job).catch(error => job.reject(Error(detail(error))));
    return true;
  }
  private async identify(port: ResetViewPort, job: Pending): Promise<void> {
    // replaceState and getContexts cross different browser IPC boundaries.
    // Allow bounded propagation, but never accept absent/ambiguous identity.
    for (let attempt = 0; attempt < 5; attempt++) {
      const contexts = await this.inventory();
      if (this.pending.get(port) !== job || !this.ports.has(port)) return;
      const matches = contexts.filter(context => {
        if (!context.documentUrl || page(context.documentUrl) !== page(port.sender?.url || '') || !this.urls.includes(page(context.documentUrl)!)) return false;
        if (present(port.sender?.documentId)) return context.documentId === port.sender.documentId;
        try { return new URL(context.documentUrl).searchParams.get(RESET_VIEW_PARAM) === job.id; } catch { return false; }
      });
      const context = matches[0];
      if (matches.length === 1 && context && (present(context.contextId) || present(context.documentId))) {
        const proof = {contextId: context.contextId, documentId: context.documentId};
        // This message only removes the ephemeral marker. It never unlocks the
        // view or gives permission to write, resume work, or resend a prompt.
        port.postMessage({type: 'reset-identified', id: job.id});
        if(this.pending.get(port)!==job||!this.ports.has(port))return;
        this.proofs.set(port, proof); job.resolve(); return;
      }
      if (matches.length > 1) throw Error('Ambiguous Miter document identity. Close duplicated Miter views and retry.');
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('A Miter document cannot confirm it stopped writing: ' + (port.sender?.url || 'unknown view') + '. Reload that Miter view and retry.');
  }
  private async inventory(): Promise<ResetViewContext[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.contexts(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Chrome did not return its open Miter document inventory. Reset remains locked.')), this.timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async quiesceAll(): Promise<void> {
    // Also include views opened while the barrier was being assembled. Never
    // loop indefinitely while a document keeps reconnecting or navigating.
    for (let attempt = 0; attempt < 8; attempt++) {
      const revision = this.revision;
      await Promise.all([...this.ports].map(port => this.quiesce(port)));
      const contexts = await this.inventory();
      if (revision !== this.revision) continue;
      const missing = contexts.filter(context => context.documentUrl && this.urls.includes(page(context.documentUrl)!) &&
        ![...this.proofs.values()].some(proof =>
          (present(proof.contextId) ? proof.contextId === context.contextId && (!present(proof.documentId) || proof.documentId === context.documentId) : present(proof.documentId) && proof.documentId === context.documentId)));
      if (missing.length) throw Error('A Miter document cannot confirm it stopped writing: ' + missing.map(context => context.documentUrl).join(', ') + '. Close old Miter tabs/panels and retry.');
      return;
    }
    throw Error('Miter views kept changing during reset. Close extra Miter windows and retry; cleanup was not authorized.');
  }
}
