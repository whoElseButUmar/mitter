import type { OutboundReceipt } from '../message-wire.js';
import type { CommittedMessage, PreparedMessage } from './types.js';

export type MessageReveal = {
  control: HTMLElement;
  attempts: number;
  at: number;
};

export type ComposerState = {
  prepared: PreparedMessage | null;
  committed: Map<string, CommittedMessage>;
};

export type ChatDomSession = ComposerState & {
  token: string;
  composerSession: string;
  stopped: boolean;
  reveals?: Map<string, MessageReveal>;
  discoveryReceipt?: OutboundReceipt;
};

export type LegacyChatDomSession = {
  stopped: boolean;
  prepared?: unknown;
  committed?: Map<string, unknown>;
  reveals?: Map<string, unknown>;
};

declare global {
  var __mitterSessionV4: ChatDomSession | undefined;
  var __mitterSessionV3: LegacyChatDomSession | undefined;
}

export function getChatDomSession(): ChatDomSession | undefined {
  return globalThis.__mitterSessionV4;
}

/** Retire in-flight work by object identity, not by turning reinjection into a
 * user Stop. Keep the token and ledger references so a lost commit response can
 * reconnect without another Send click. An actual Stop never resumes here. */
export function retireChatDomSession(): void {
  const previous = globalThis.__mitterSessionV4;
  if (previous) {
    const stopped = previous.stopped === true;
    previous.stopped = true;
    globalThis.__mitterSessionV4 = { ...previous, stopped };
  }
  const legacy = globalThis.__mitterSessionV3;
  if (legacy) {
    legacy.stopped = true;
  }
}

/** Clear only document-local automation state, never provider messages or drafts. */
export function resetChatDomSessions(): void {
  const sessions = [globalThis.__mitterSessionV3, globalThis.__mitterSessionV4];
  for (const session of sessions) {
    if (session) {
      session.stopped = true;
      session.prepared = null;
      session.committed?.clear();
      session.reveals?.clear();
    }
  }
  Reflect.deleteProperty(globalThis, '__mitterSessionV3');
  Reflect.deleteProperty(globalThis, '__mitterSessionV4');
}
