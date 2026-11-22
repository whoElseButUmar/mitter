import { domRequestSchema, PAGE_READER_REVISION, type ChatView, type DomRequest } from './dom/types.js';
import { PAGE_CHANNEL, pageHelloSchema, pageReplyHeaderSchema } from './transport/messages.js';
import { PageBridgeError } from './transport/page-error.js';
import { readPageState } from './transport/page-state.js';

export { PAGE_CHANNEL, PAGE_READER } from './transport/messages.js';
export { PageBridgeError } from './transport/page-error.js';

export type PageAPI = {
  send(tabId: number, message: unknown): Promise<unknown>;
  inject(tabId: number): Promise<void>;
  checkAvailable?(tabId: number): Promise<void>;
};

function isReadOperation(operation: DomRequest['op']): boolean {
  return (
    operation === 'control' ||
    operation === 'inspect' ||
    operation === 'probe' ||
    operation === 'reply' ||
    operation === 'read_generated_image'
  );
}

/** Injection installs a packaged file. Only an authenticated request response
 * can supply an operation result, and an ambiguous mutation is never replayed. */
export class PageTransport {
  private attachedTabs = new Map<number, number | undefined>();
  private documentGenerations = new Map<number, symbol>();
  private pendingConnections = new Map<number, Promise<void>>();

  constructor(
    private api: PageAPI,
    private log: (kind: string, message: string) => void,
    private timeoutMs = 18000,
  ) {}

  private async withTimeout<Result>(task: Promise<Result>, timeoutMs = this.timeoutMs): Promise<Result> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new PageBridgeError('BRIDGE_TIMEOUT', 'The chat page did not answer the bridge request.', true),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([task, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async exchange(tabId: number, kind: string, action?: DomRequest): Promise<unknown> {
    const requestId = crypto.randomUUID();
    let timeoutMs = this.timeoutMs;

    // A read may reconnect. A timed-out composer mutation remains ambiguous.
    if (kind === 'hello') {
      timeoutMs = Math.min(this.timeoutMs, 3000);
    } else if (action?.op === 'read_generated_image') {
      timeoutMs = Math.min(this.timeoutMs, 15000);
    } else if (action && isReadOperation(action.op)) {
      timeoutMs = Math.min(this.timeoutMs, 6000);
    }

    let rawReply: unknown;

    try {
      const message = { channel: PAGE_CHANNEL, id: requestId, kind, action };
      rawReply = await this.withTimeout(this.api.send(tabId, message), timeoutMs);
    } catch (error) {
      if (error instanceof PageBridgeError) {
        throw error;
      }

      let reason = 'Could not reach the chat page.';

      if (error instanceof Error) {
        reason = error.message;
      }

      throw new PageBridgeError('BRIDGE_DISCONNECTED', reason, true);
    }

    const result = pageReplyHeaderSchema.safeParse(rawReply);

    if (!result.success || result.data.id !== requestId) {
      throw new PageBridgeError(
        'INVALID_BRIDGE_REPLY',
        'The page bridge returned an invalid response. No action result was accepted.',
        true,
        { cause: result.error },
      );
    }

    const reply = result.data;

    if (!reply.ok) {
      throw new PageBridgeError(
        reply.error?.code || 'PAGE_ERROR',
        reply.error?.message || 'A page operation failed.',
      );
    }

    if (rawReply && typeof rawReply === 'object' && 'value' in rawReply) {
      return rawReply.value;
    }
    return undefined;
  }

  async ensure(tabId: number, minimumRevision = 0): Promise<void> {
    if (this.attachedTabs.has(tabId) && (this.attachedTabs.get(tabId) ?? 0) >= minimumRevision) {
      return;
    }

    const pendingConnection = this.pendingConnections.get(tabId);

    if (pendingConnection) {
      await pendingConnection;
      return this.ensure(tabId, minimumRevision);
    }

    this.attachedTabs.delete(tabId);
    // A fresh identity cannot become current again after forget releases its entry.
    const generation = Symbol();
    this.documentGenerations.set(tabId, generation);

    const checkDocument = (): void => {
      if (this.documentGenerations.get(tabId) !== generation) {
        throw new PageBridgeError(
          'BRIDGE_NAVIGATED',
          'The chat document changed during connection. Rechecking without repeating Send.',
          true,
        );
      }
    };

    const handshake = async () => {
      const identity = await this.exchange(tabId, 'hello');

      const hello = pageHelloSchema.safeParse(identity);
      if (!hello.success || (hello.data.readerRevision ?? 0) < minimumRevision) {
        this.log(
          'bridge.upgrade',
          'Refreshing an older or incompatible page reader. No message is being resent.',
        );
        throw new PageBridgeError(
          'STALE_PAGE_READER',
          'The chat page is using an older reader. The packaged reader must be installed before continuing.',
          true,
          { cause: hello.error },
        );
      }
      return hello.data;
    };

    const connect = async (): Promise<void> => {
      let hello;
      try {
        hello = await handshake();
      } catch {
        checkDocument();
        this.log('bridge.attach', `Installing packaged bridge in tab ${tabId}.`);

        try {
          await this.withTimeout(this.api.inject(tabId), Math.min(this.timeoutMs, 6000));
        } catch (error) {
          checkDocument();
          let reason = 'Chrome refused page access.';

          if (error instanceof Error) {
            reason = error.message;
          }

          throw new PageBridgeError('BRIDGE_INJECTION_FAILED', reason, true);
        }

        checkDocument();
        hello = await handshake();
      }

      checkDocument();
      this.attachedTabs.set(tabId, hello.readerRevision);
      this.log(
        'bridge.ready',
        `Page handshake confirmed in tab ${tabId}; ${hello.version}; reader=${hello.reader}; revision=${hello.readerRevision ?? 'unreported'}.`,
      );
    };

    const connection = connect();
    this.pendingConnections.set(tabId, connection);

    try {
      await connection;
    } finally {
      if (this.pendingConnections.get(tabId) === connection) {
        this.pendingConnections.delete(tabId);
      }
      if (!this.attachedTabs.has(tabId) && this.documentGenerations.get(tabId) === generation) {
        this.documentGenerations.delete(tabId);
      }
    }
  }

  forget(tabId: number): void {
    this.attachedTabs.delete(tabId);
    this.pendingConnections.delete(tabId);
    this.documentGenerations.delete(tabId);
  }

  async request(tabId: number, action: DomRequest, beforeSend?: () => void): Promise<ChatView> {
    const parsedAction = domRequestSchema.safeParse(action);
    if (!parsedAction.success) {
      throw new PageBridgeError('BAD_REQUEST', 'Invalid page bridge request.', false, {
        cause: parsedAction.error,
      });
    }
    action = parsedAction.data;
    let attempts = 1;

    if (isReadOperation(action.op)) {
      attempts = 2;
    }

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        if (action.op !== 'stop' && action.op !== 'interrupt' && this.api.checkAvailable) {
          try {
            await this.withTimeout(this.api.checkAvailable(tabId), Math.min(this.timeoutMs, 3000));
          } catch (error) {
            if (error instanceof PageBridgeError) {
              throw error;
            }

            throw new PageBridgeError(
              'BRIDGE_DISCONNECTED',
              'Could not check the linked chat’s browser state: ' + String(error),
              true,
            );
          }
        }

        let minimumRevision = 0;
        if (
          action.op === 'attach_image' ||
          action.op === 'read_generated_image' ||
          (action.op === 'inspect' && action.receipt && action.replyTo) ||
          action.imageAttachments?.length
        ) {
          minimumRevision = PAGE_READER_REVISION;
        }
        await this.ensure(tabId, minimumRevision);
        const generation = this.documentGenerations.get(tabId);
        if (generation === undefined) {
          throw new PageBridgeError(
            'BRIDGE_NAVIGATED',
            'The chat document changed before the operation could start. No page operation was sent.',
            true,
          );
        }
        // Recheck mutation ownership after browser availability and handshake
        // awaits. No asynchronous work may separate this guard from dispatch.
        beforeSend?.();
        const rawState = await this.exchange(tabId, 'request', action);

        if (this.documentGenerations.get(tabId) !== generation) {
          throw new PageBridgeError(
            'BRIDGE_NAVIGATED',
            'The chat document changed while answering. Its old response was ignored; Send was not repeated.',
            true,
          );
        }

        return readPageState(rawState, action.op);
      } catch (error) {
        let pageError: PageBridgeError;

        if (error instanceof PageBridgeError) {
          pageError = error;
        } else {
          pageError = new PageBridgeError('PAGE_ERROR', String(error));
        }

        this.log('bridge.page.error', `${action.op} / ${pageError.code}: ${pageError.message}`);
        const documentUnavailable = ['BRIDGE_NAVIGATED', 'TAB_FROZEN', 'TAB_DISCARDED'].includes(
          pageError.code,
        );

        if (pageError.transient && !documentUnavailable) {
          this.forget(tabId);
        }

        if (!pageError.transient || attempt + 1 === attempts) {
          throw pageError;
        }
      }
    }

    throw new PageBridgeError('BRIDGE_DISCONNECTED', 'The page bridge could not reconnect.', true);
  }
}
