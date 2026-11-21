import { isProviderOrigin } from './providers.js';

/** Canonical routing for the existing page adapter. Message ownership is checked by the runner. */
export function chatgptAddress(raw: string, allowNewChat = false): string | undefined {
  try {
    const url = new URL(raw);
    if (!isProviderOrigin('chatgpt', raw)) {
      return undefined;
    }
    const conversation = /^\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]+\/?$/.test(url.pathname);
    if (!conversation && !(allowNewChat && url.pathname === '/')) {
      return undefined;
    }
    return url.origin + url.pathname.replace(/\/$/, '');
  } catch {
    return undefined;
  }
}
