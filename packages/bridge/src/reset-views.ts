import { z } from 'zod';

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

export const resetViewContextSchema = z
  .object({
    contextId: z.string().optional().describe('The browser context that contains this Miter view.'),
    documentId: z.string().optional().describe('The browser document currently shown in this Miter view.'),
    documentUrl: z.string().optional().describe('The address currently shown in this Miter view.'),
  })
  .describe('An open Miter view reported by the browser.');
export type ResetViewContext = z.infer<typeof resetViewContextSchema>;
const resetViewInventorySchema = z
  .array(resetViewContextSchema)
  .describe('Browser-reported open document inventory used to verify every reset writer barrier.');

export type ResetViewPort = {
  sender?: { url?: string; documentId?: string };
  postMessage(message: unknown): void;
};

const documentProofSchema = resetViewContextSchema
  .omit({ documentUrl: true })
  .describe('Browser IDs proving which Miter document stopped writing.');
type DocumentProof = z.infer<typeof documentProofSchema>;

type PendingQuiescence = {
  requestId: string;
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  verifying: boolean;
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function documentPageURL(url: string): string {
  const suffixStart = url.search(/[?#]/);
  if (suffixStart < 0) {
    return url;
  }

  return url.slice(0, suffixStart);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export class ResetViewBarrier {
  private ports = new Set<ResetViewPort>();
  private pending = new Map<ResetViewPort, PendingQuiescence>();
  private proofs = new Map<ResetViewPort, DocumentProof>();
  private revision = 0;

  constructor(
    private urls: readonly string[],
    private contexts: () => Promise<unknown>,
    private timeoutMs = 15000,
  ) {}

  add(port: ResetViewPort): void {
    this.ports.add(port);
    this.revision++;
  }

  remove(port: ResetViewPort): void {
    this.ports.delete(port);
    this.proofs.delete(port);
    this.revision++;

    this.pending
      .get(port)
      ?.reject(
        new Error('A Miter view disconnected before confirming cleanup. Reopen Miter and retry the reset.'),
      );
  }

  dispose(): void {
    for (const port of [...this.ports]) {
      this.remove(port);
    }
  }

  quiesce(port: ResetViewPort): Promise<void> {
    if (!this.ports.has(port)) {
      return Promise.reject(new Error('The Miter view is no longer connected.'));
    }

    const pendingRequest = this.pending.get(port);
    if (pendingRequest) {
      return pendingRequest.promise;
    }

    if (this.proofs.has(port)) {
      return Promise.resolve();
    }

    const requestId = crypto.randomUUID();
    const callbacks: { resolve?: () => void; reject?: (error: Error) => void } = {};
    const promise = new Promise<void>((resolve, reject) => {
      callbacks.resolve = resolve;
      callbacks.reject = reject;
    });
    const { resolve: resolveQuiescence, reject: rejectQuiescence } = callbacks;
    if (!resolveQuiescence || !rejectQuiescence) {
      throw new Error('Could not initialize the Miter view reset acknowledgement.');
    }
    const timer = setTimeout(
      () =>
        rejectQuiescence(
          new Error(
            'Open Miter view did not acknowledge reset: ' +
              (port.sender?.url || 'unknown view') +
              '. Close that view and retry.',
          ),
        ),
      this.timeoutMs,
    );
    const request: PendingQuiescence = {
      requestId,
      promise,
      resolve: resolveQuiescence,
      reject: rejectQuiescence,
      timer,
      verifying: false,
    };
    this.pending.set(port, request);

    void promise
      .finally(() => {
        clearTimeout(timer);
        if (this.pending.get(port) === request) {
          this.pending.delete(port);
        }
      })
      .catch(() => {});

    try {
      port.postMessage({
        type: 'reset-quiesce',
        id: requestId,
        identify: !isNonEmptyString(port.sender?.documentId),
      });
    } catch (error) {
      rejectQuiescence(new Error('Could not contact Miter view: ' + errorMessage(error)));
    }
    return promise;
  }

  receive(port: ResetViewPort, message: unknown): boolean {
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'reset-ack') {
      return false;
    }
    const request = this.pending.get(port);
    if (
      !request ||
      !('id' in message) ||
      typeof message.id !== 'string' ||
      message.id !== request.requestId ||
      request.verifying
    ) {
      return true;
    }
    request.verifying = true;
    if (!('ok' in message) || message.ok !== true) {
      let error = 'The view did not confirm data cleanup.';
      if ('error' in message && typeof message.error === 'string') {
        error = message.error.slice(0, 2000);
      }
      request.reject(new Error((port.sender?.url || 'Miter view') + ': ' + error));
      return true;
    }

    void this.identify(port, request).catch((error) =>
      request.reject(new Error(errorMessage(error), { cause: error })),
    );
    return true;
  }

  private async identify(port: ResetViewPort, request: PendingQuiescence): Promise<void> {
    // replaceState and getContexts cross different browser IPC boundaries.
    // Allow bounded propagation, but never accept absent/ambiguous identity.
    for (let attempt = 0; attempt < 5; attempt++) {
      const contexts = await this.inventory();
      if (this.pending.get(port) !== request || !this.ports.has(port)) {
        return;
      }
      const matches = contexts.filter((context) => {
        if (
          !context.documentUrl ||
          documentPageURL(context.documentUrl) !== documentPageURL(port.sender?.url || '') ||
          !this.urls.includes(documentPageURL(context.documentUrl))
        ) {
          return false;
        }
        if (isNonEmptyString(port.sender?.documentId)) {
          return context.documentId === port.sender.documentId;
        }
        try {
          return new URL(context.documentUrl).searchParams.get(RESET_VIEW_PARAM) === request.requestId;
        } catch {
          return false;
        }
      });
      const context = matches[0];
      if (
        matches.length === 1 &&
        context &&
        (isNonEmptyString(context.contextId) || isNonEmptyString(context.documentId))
      ) {
        const proof = {
          contextId: context.contextId,
          documentId: context.documentId,
        };
        // This message only removes the ephemeral marker. It never unlocks the
        // view or gives permission to write, resume work, or resend a prompt.
        port.postMessage({ type: 'reset-identified', id: request.requestId });
        if (this.pending.get(port) !== request || !this.ports.has(port)) {
          return;
        }
        this.proofs.set(port, proof);
        request.resolve();
        return;
      }
      if (matches.length > 1) {
        throw new Error('Ambiguous Miter document identity. Close duplicated Miter views and retry.');
      }
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(
      'A Miter document cannot confirm it stopped writing: ' +
        (port.sender?.url || 'unknown view') +
        '. Reload that Miter view and retry.',
    );
  }

  private async inventory(): Promise<ResetViewContext[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const inventory = await Promise.race([
        this.contexts(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error('Chrome did not return its open Miter document inventory. Reset remains locked.'),
              ),
            this.timeoutMs,
          );
        }),
      ]);
      const result = resetViewInventorySchema.safeParse(inventory);
      if (!result.success) {
        throw new Error(
          'Chrome returned an invalid Miter document inventory. Reset remains locked; reload Miter and retry.',
          {
            cause: result.error,
          },
        );
      }
      return result.data;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async quiesceAll(): Promise<void> {
    // Also include views opened while the barrier was being assembled. Never
    // loop indefinitely while a document keeps reconnecting or navigating.
    for (let attempt = 0; attempt < 8; attempt++) {
      const revision = this.revision;
      await Promise.all([...this.ports].map((port) => this.quiesce(port)));

      const contexts = await this.inventory();
      if (revision !== this.revision) {
        continue;
      }
      const missing = contexts.filter((context) => {
        if (!context.documentUrl || !this.urls.includes(documentPageURL(context.documentUrl))) {
          return false;
        }
        const confirmed = [...this.proofs.values()].some((proof) => {
          if (isNonEmptyString(proof.contextId)) {
            return (
              proof.contextId === context.contextId &&
              (!isNonEmptyString(proof.documentId) || proof.documentId === context.documentId)
            );
          }
          return isNonEmptyString(proof.documentId) && proof.documentId === context.documentId;
        });
        return !confirmed;
      });
      if (missing.length) {
        throw new Error(
          'A Miter document cannot confirm it stopped writing: ' +
            missing.map((context) => context.documentUrl).join(', ') +
            '. Close old Miter tabs/panels and retry.',
        );
      }
      return;
    }
    throw new Error(
      'Miter views kept changing during reset. Close extra Miter windows and retry; cleanup was not authorized.',
    );
  }
}
