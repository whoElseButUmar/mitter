import { z } from 'zod';
import { identifierSchema, nonNegativeIntegerSchema } from './schemas/primitives.js';
import { PageBridgeError } from './page-transport.js';
import { rewritePrompt, parseRewriteReply } from '../../protocol/src/rewrite.js';
import type { RewriteRequest } from '../../protocol/src/rewrite.js';
import { conversationURL } from './runner/chat-identity.js';
import { sameMessage } from './message-wire.js';
import type { DomRequest } from './chat-dom.js';
import { readPageState } from './transport/page-state.js';

export const rewriteResultSchema = z
  .object({
    id: identifierSchema.describe('The request whose draft is being rewritten.'),
    state: z
      .enum(['waiting', 'done', 'error', 'cancelled'])
      .describe('Whether the rewrite is waiting, finished, failed, or cancelled.'),
    text: z.string().optional().describe('The rewritten draft returned when the job finishes.'),
    error: z.string().optional().describe('Why the draft could not be rewritten.'),
    tabId: nonNegativeIntegerSchema.describe('The browser tab used to rewrite the draft.'),
    at: z.number().describe('When the rewrite started, in milliseconds since the Unix epoch.'),
  })
  .describe('The status and result of one draft rewrite.');
export type RewriteResult = z.infer<typeof rewriteResultSchema>;

/** Independent composer-only job. It has NO host RPC/worker/action executor. */
export class RewriteRunner {
  readonly result: RewriteResult;
  private token = crypto.randomUUID();
  private cancelled = false;
  private cancelStop: Promise<void> | undefined;
  private route = 'https://chatgpt.com';
  private committed = false;
  private execution?: Promise<void>;

  constructor(
    readonly id: string,
    readonly tabId: number,
    private rewriteRequest: RewriteRequest,
    private page: (tabId: number, request: DomRequest, beforeSend?: () => void) => Promise<unknown>,
    private now = Date.now,
    private wait = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
  ) {
    this.result = { id, tabId, state: 'waiting', at: now() };
  }

  private checkActive() {
    if (this.cancelled) {
      throw new Error('Rewrite cancelled.');
    }
    if (this.now() - this.result.at > 180000) {
      throw new Error('The rewrite timed out. Your original draft is unchanged.');
    }
  }

  private async requestPage(
    op: DomRequest['op'],
    text?: string,
    messageId?: string,
    composerSession?: string,
  ) {
    this.checkActive();
    const observation = await this.page(
      this.tabId,
      {
        op,
        token: this.token,
        url: this.route,
        text,
        messageId,
        composerSession,
        expiresAt: this.result.at + 180000,
        allowConversationBind: this.committed && !this.route.includes('/c/'),
      },
      () => this.checkActive(),
    );
    this.checkActive();
    const view = readPageState(observation, op);
    if (view.stopped) {
      throw new Error('Rewrite paused from the chat page.');
    }
    if (
      this.route.includes('/c/') &&
      view.url !== this.route &&
      !(op === 'inspect' && view.ready === false && view.url === 'https://chatgpt.com')
    ) {
      throw new Error('The rewrite tab changed conversation.');
    }
    return view;
  }

  run(): Promise<void> {
    return (this.execution ??= this.execute());
  }

  async settled(): Promise<void> {
    await this.execution;
    await this.cancelStop;
  }

  private async observe(op: 'probe' | 'inspect') {
    try {
      const view = await this.requestPage(op);
      if (view.ready !== false) {
        return view;
      }
    } catch (error) {
      if (
        !(error instanceof PageBridgeError) ||
        !error.transient ||
        ['INVALID_PAGE_STATE', 'INVALID_BRIDGE_REPLY'].includes(error.code)
      ) {
        throw error;
      }
      this.checkActive();
    }
    return undefined;
  }

  private async execute(): Promise<void> {
    try {
      let view = await this.observe('probe');
      while (!view) {
        await this.wait(500);
        view = await this.observe('probe');
      }

      if (view.busy || view.draft || view.count > 0) {
        throw new Error('The new rewrite chat is not empty. No draft was overwritten.');
      }

      const prompt = rewritePrompt(this.rewriteRequest, this.id);
      const messageId = crypto.randomUUID();
      while (true) {
        try {
          view = await this.requestPage('prepare', prompt, messageId);
          if (view.outcome !== 'pending') {
            break;
          }
        } catch (error) {
          const canRetry =
            error instanceof PageBridgeError &&
            (error.transient ||
              ['COMPOSER_BUSY', 'COMPOSER_MISSING', 'EDITOR_REPLACED', 'BUSY', 'INSERT_REJECTED'].includes(
                error.code,
              ));
          if (!canRetry || (error instanceof PageBridgeError && error.code === 'INVALID_PAGE_STATE')) {
            throw error;
          }
        }
        await this.wait(1200);
        this.checkActive();
      }
      if (!['prepared', 'already_sent', 'already_clicked'].includes(view.outcome || '')) {
        throw new Error('The rewrite draft could not be prepared.');
      }

      this.committed = true;
      if (view.outcome === 'prepared') {
        while (true) {
          try {
            const commitResult = await this.requestPage('commit', prompt, messageId, view.composerSession);
            if (commitResult.outcome !== 'pending') {
              break;
            }
          } catch (error) {
            if (this.cancelled) {
              throw error;
            }
            if (
              !(error instanceof PageBridgeError) ||
              ['COMMIT_DOCUMENT_CHANGED', 'INVALID_PAGE_STATE', 'INVALID_BRIDGE_REPLY'].includes(error.code)
            ) {
              // unknown outcome: inspect only
              break;
            }
            if (!error.transient && !['COMPOSER_BUSY', 'BUSY', 'SEND_NOT_READY'].includes(error.code)) {
              throw error;
            }
            // No document-local proof means a lost acknowledgement is read-only.
            if (!view.composerSession) {
              break;
            }
          }
          await this.wait(1200);
          this.checkActive();
        }
      }

      let candidate = '';
      let stableAt = 0;
      while (true) {
        await this.wait(1200);
        const observed = await this.observe('inspect');
        if (!observed) {
          candidate = '';
          continue;
        }
        view = observed;
        if (view.draft) {
          // React may clear the submitted composer after the click acknowledgement.
          // Wait read-only for our exact text; a different draft is still a barrier.
          if (sameMessage(view.draftText, prompt)) {
            candidate = '';
            stableAt = 0;
            continue;
          }
          throw new Error('A draft appeared in the rewrite chat. Nothing was overwritten.');
        }
        if (
          view.lastUserText &&
          !sameMessage(view.lastUserText, prompt) &&
          !sameMessage(view.lastUserText, 'text\n' + prompt)
        ) {
          throw new Error('The rewrite chat contains a different user message.');
        }
        if (!view.lastUserText) {
          candidate = '';
          continue;
        }
        if (!this.route.includes('/c/')) {
          try {
            this.route = conversationURL(view.url);
          } catch {}
        }
        if (view.busy || !view.complete || view.assistantReadIssue || !view.assistantText) {
          candidate = '';
          continue;
        }

        if (candidate !== view.assistantText) {
          candidate = view.assistantText;
          stableAt = this.now();
          continue;
        }
        if (this.now() - stableAt < 1800) {
          continue;
        }

        this.result.text = parseRewriteReply(candidate, this.id);
        this.result.state = 'done';
        break;
      }
    } catch (error) {
      if (this.cancelled) {
        this.result.state = 'cancelled';
      } else {
        this.result.state = 'error';
      }

      if (error instanceof Error) {
        this.result.error = error.message;
      } else {
        this.result.error = String(error);
      }
    } finally {
      try {
        await this.page(this.tabId, {
          op: 'stop',
          token: this.token,
          url: this.route,
          expiresAt: this.now() + 10000,
        });
      } catch {}
    }
  }

  cancel() {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    this.result.state = 'cancelled';
    this.cancelStop = this.page(this.tabId, {
      op: 'stop',
      token: this.token,
      url: this.route,
      expiresAt: this.now() + 10000,
    }).then(
      () => {},
      () => {},
    );
  }
}
