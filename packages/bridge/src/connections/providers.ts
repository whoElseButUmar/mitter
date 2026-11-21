import { z } from 'zod';

export const chatProviderIdSchema = z
  .enum(['chatgpt', 'gemini', 'perplexity'])
  .describe('The chat service selected for a connection; never inferred from model output.');

export const connectionCapabilitiesSchema = z
  .strictObject({
    manualHandoff: z.boolean().describe('Whether prompts and replies can be exchanged by the user.'),
    browserBridge: z.boolean().describe('Whether Miter implements a page adapter for this service.'),
  })
  .describe('Implemented transports, not website permissions or authorization to send a message.');

export type ChatProviderId = z.infer<typeof chatProviderIdSchema>;
export type ConnectionCapabilities = z.infer<typeof connectionCapabilitiesSchema>;

type ChatProvider = {
  readonly id: ChatProviderId;
  readonly label: string;
  readonly startUrl: string;
  readonly origins: readonly string[];
  readonly capabilities: Readonly<ConnectionCapabilities>;
};

export const chatgptProvider = Object.freeze({
  id: 'chatgpt' as const,
  label: 'ChatGPT',
  startUrl: 'https://chatgpt.com',
  origins: Object.freeze(['https://chatgpt.com', 'https://chat.openai.com']),
  capabilities: Object.freeze({ manualHandoff: true, browserBridge: true }),
});

const geminiProvider: ChatProvider = Object.freeze({
  id: 'gemini',
  label: 'Gemini',
  startUrl: 'https://gemini.google.com/app',
  origins: Object.freeze(['https://gemini.google.com']),
  capabilities: Object.freeze({ manualHandoff: true, browserBridge: false }),
});

const perplexityProvider: ChatProvider = Object.freeze({
  id: 'perplexity',
  label: 'Perplexity',
  startUrl: 'https://www.perplexity.ai',
  origins: Object.freeze(['https://www.perplexity.ai']),
  capabilities: Object.freeze({ manualHandoff: true, browserBridge: false }),
});

export function chatProvider(providerId: ChatProviderId): ChatProvider {
  switch (chatProviderIdSchema.parse(providerId)) {
    case 'chatgpt':
      return chatgptProvider;
    case 'gemini':
      return geminiProvider;
    case 'perplexity':
      return perplexityProvider;
  }
}

export function isProviderOrigin(providerId: ChatProviderId, address: string): boolean {
  try {
    const url = new URL(address);
    return !url.username && !url.password && chatProvider(providerId).origins.includes(url.origin);
  } catch {
    return false;
  }
}

export function requireBrowserBridge(providerId: ChatProviderId): void {
  const provider = chatProvider(providerId);
  if (!provider.capabilities.browserBridge) {
    throw new Error(`${provider.label} supports manual handoff only. No browser adapter is installed.`);
  }
}

export const connectionIdentitySchema = z
  .strictObject({
    providerId: chatProviderIdSchema,
    url: z.string().max(2000).describe('The selected page address on the named chat service.'),
  })
  .refine((connection) => isProviderOrigin(connection.providerId, connection.url), {
    message: 'The connection address must belong to its selected provider.',
    path: ['url'],
  })
  .describe('Provider-bound page identity; does not prove a conversation, turn, or execution grant.');

export type ConnectionIdentity = z.infer<typeof connectionIdentitySchema>;
