import { chatDom, clearChatDomState } from './chat-dom.js';
import { retireChatDomSession } from './dom/session-state.js';
import { PAGE_READER_REVISION, type ChatView } from './dom/types.js';
import {
  PAGE_CHANNEL,
  PAGE_READER,
  pageHelloRequestSchema,
  pageMessageHeaderSchema,
  pageOperationErrorSchema,
  pageRequestSchema,
  pageResetSchema,
  type PageReply,
} from './transport/messages.js';

export type PageMessageSender = {
  id?: string;
  tab?: unknown;
};

export type PageMessageListener = (
  message: unknown,
  sender: PageMessageSender,
  respond: (reply: unknown) => void,
) => boolean;

export type PageRuntime = {
  id: string;
  onMessage: {
    addListener(listener: PageMessageListener): void;
    removeListener(listener: PageMessageListener): void;
  };
};

type InstalledEndpoint = {
  runtimeId: string;
  version: string;
  listener: PageMessageListener;
};

type PendingPageRequest = {
  body: string;
  promise: Promise<PageReply>;
};

declare global {
  var __mitterPageEndpointV3: InstalledEndpoint | undefined;
  var __mitterPageEndpointV4: InstalledEndpoint | undefined;
}

/** Runs in the packaged isolated-world content script, never the page's main world. */
export function installPageEndpoint(runtime: PageRuntime): void {
  const previousEndpoints = [globalThis.__mitterPageEndpointV3, globalThis.__mitterPageEndpointV4];

  for (const endpoint of previousEndpoints) {
    if (!endpoint) {
      continue;
    }

    try {
      runtime.onMessage.removeListener(endpoint.listener);
    } catch {
      // The old extension context may already have been retired.
    }
  }

  Reflect.deleteProperty(globalThis, '__mitterPageEndpointV3');
  retireChatDomSession();

  const instanceId = crypto.randomUUID();
  const pendingRequests = new Map<string, PendingPageRequest>();
  const inFlightRequests = new Set<Promise<PageReply>>();
  let retired = false;
  let composerMutation: Promise<ChatView> | undefined;

  const listener: PageMessageListener = (message, sender, respond) => {
    if (sender.id !== runtime.id || sender.tab || globalThis.__mitterPageEndpointV4?.listener !== listener) {
      return false;
    }

    const parsedHeader = pageMessageHeaderSchema.safeParse(message);

    if (!parsedHeader.success) {
      return false;
    }

    const header: Pick<PageReply, 'channel' | 'id' | 'instanceId'> = {
      channel: PAGE_CHANNEL,
      id: parsedHeader.data.id,
      instanceId,
    };

    if (pageResetSchema.safeParse(message).success) {
      retired = true;

      const finishReset = async (): Promise<void> => {
        try {
          clearChatDomState();
        } finally {
          await Promise.allSettled([...inFlightRequests]);
          pendingRequests.clear();
          inFlightRequests.clear();
          composerMutation = undefined;
          try {
            runtime.onMessage.removeListener(listener);
          } finally {
            // Reinjection may replace this endpoint while its old requests drain.
            if (globalThis.__mitterPageEndpointV4?.listener === listener) {
              try {
                clearChatDomState();
              } finally {
                Reflect.deleteProperty(globalThis, '__mitterPageEndpointV4');
              }
            }
          }
        }
        respond({ ...header, ok: true, value: { cleared: true } });
      };

      void finishReset().catch((error) => {
        const failure = pageOperationErrorSchema.safeParse(error);
        let explanation = 'The page reset could not finish.';
        if (failure.success) {
          explanation = failure.data.message ?? explanation;
        }
        try {
          respond({ ...header, ok: false, error: { code: 'RESET_FAILED', message: explanation } });
        } catch {
          // The response channel may have closed while cleanup was draining.
        }
      });
      return true;
    }

    if (retired) {
      respond({
        ...header,
        ok: false,
        error: { code: 'RESET', message: 'Miter data was reset.' },
      });
      return false;
    }

    if (pageHelloRequestSchema.safeParse(message).success) {
      respond({
        ...header,
        ok: true,
        value: {
          version: PAGE_CHANNEL,
          reader: PAGE_READER,
          readerRevision: PAGE_READER_REVISION,
          instanceId,
          url: location.origin + location.pathname,
          readyState: document.readyState,
        },
      });
      return false;
    }

    const parsedRequest = pageRequestSchema.safeParse(message);

    if (!parsedRequest.success) {
      respond({
        ...header,
        ok: false,
        error: { code: 'BAD_REQUEST', message: 'Invalid page bridge request.' },
      });
      return false;
    }

    const action = parsedRequest.data.action;
    const requestBody = JSON.stringify(action);
    const existingRequest = pendingRequests.get(header.id);

    if (existingRequest && existingRequest.body !== requestBody) {
      respond({
        ...header,
        ok: false,
        error: {
          code: 'ID_CONFLICT',
          message: 'Request ID reused with a different operation.',
        },
      });
      return false;
    }

    const perform = async (): Promise<PageReply> => {
      try {
        const changesComposer =
          action.op === 'prepare' ||
          action.op === 'attach_image' ||
          action.op === 'commit' ||
          action.op === 'send' ||
          action.op === 'clear_draft';

        if (changesComposer) {
          if (composerMutation) {
            return {
              ...header,
              ok: false,
              error: {
                code: 'COMPOSER_BUSY',
                message: 'Another task is changing the composer.',
              },
            };
          }

          const operation = chatDom(action);
          composerMutation = operation;

          try {
            return { ...header, ok: true, value: await operation };
          } finally {
            if (composerMutation === operation) {
              composerMutation = undefined;
            }
          }
        }

        return { ...header, ok: true, value: await chatDom(action) };
      } catch (error) {
        const failure = pageOperationErrorSchema.safeParse(error);
        let code = 'PAGE_OPERATION_FAILED';
        let explanation = 'The page operation failed.';

        if (failure.success) {
          code = failure.data.code ?? code;
          explanation = failure.data.message ?? explanation;
        }

        return { ...header, ok: false, error: { code, message: explanation } };
      }
    };

    let reply: Promise<PageReply>;

    if (existingRequest) {
      reply = existingRequest.promise;
    } else {
      reply = perform();
      pendingRequests.set(header.id, { body: requestBody, promise: reply });
      inFlightRequests.add(reply);

      void reply
        .finally(() => {
          inFlightRequests.delete(reply);
          if (action.op === 'attach_image' && action.image?.base64) {
            // The document-local upload ledger handles retries after this response.
            // Keep large image bodies only while they are in flight.
            pendingRequests.delete(header.id);
          }
        })
        .catch(() => {});

      while (pendingRequests.size > 24) {
        const oldestId = pendingRequests.keys().next().value;

        if (oldestId === undefined) {
          break;
        }

        pendingRequests.delete(oldestId);
      }
    }

    void reply.then(respond).catch(() => {});

    // Chrome versions differ in support for promise-returning message listeners.
    // A literal true keeps sendResponse open on every supported version.
    return true;
  };

  runtime.onMessage.addListener(listener);
  globalThis.__mitterPageEndpointV4 = {
    runtimeId: runtime.id,
    version: PAGE_CHANNEL,
    listener,
  };
}
