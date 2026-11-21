import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatgptAddress } from './chatgpt.ts';
import {
  chatProvider,
  connectionCapabilitiesSchema,
  connectionIdentitySchema,
  isProviderOrigin,
  requireBrowserBridge,
} from './providers.ts';

test('provider identities accept only their own HTTPS origins without credentials', () => {
  for (const [providerId, url] of [
    ['chatgpt', 'https://chatgpt.com/c/task'],
    ['chatgpt', 'https://chat.openai.com/c/task'],
    ['gemini', 'https://gemini.google.com/app/task'],
    ['perplexity', 'https://www.perplexity.ai/search/task'],
  ]) {
    assert.deepEqual(connectionIdentitySchema.parse({ providerId, url }), { providerId, url });
  }
  for (const [providerId, url] of [
    ['chatgpt', 'https://gemini.google.com/app/task'],
    ['gemini', 'https://chatgpt.com/c/task'],
    ['perplexity', 'https://www.perplexity.ai.example.com/search/task'],
    ['chatgpt', 'https://chatgpt.com.evil.example/c/task'],
    ['chatgpt', 'http://chatgpt.com/c/task'],
    ['chatgpt', 'https://chatgpt.com:8443/c/task'],
    ['chatgpt', 'https://user:secret@chatgpt.com/c/task'],
    ['chatgpt', 'https://chatgpt.com@evil.example/c/task'],
    ['chatgpt', 'not a url'],
    ['unknown', 'https://chatgpt.com/c/task'],
  ]) {
    assert.equal(connectionIdentitySchema.safeParse({ providerId, url }).success, false, url);
    assert.equal(isProviderOrigin(providerId, url), false, url);
  }
});

test('provider capabilities cannot be promoted by connection data or modified at runtime', () => {
  for (const providerId of ['chatgpt', 'gemini', 'perplexity']) {
    const provider = chatProvider(providerId);
    assert.equal(isProviderOrigin(providerId, provider.startUrl), true);
    assert.equal(connectionCapabilitiesSchema.safeParse(provider.capabilities).success, true);
    assert.equal(provider.capabilities.manualHandoff, true);
    assert.throws(() => {
      provider.capabilities.browserBridge = true;
    }, TypeError);
    assert.throws(() => {
      provider.origins.push('https://evil.example');
    }, TypeError);
    assert.equal(
      connectionIdentitySchema.safeParse({
        providerId,
        url: provider.startUrl,
        capabilities: { browserBridge: true },
      }).success,
      false,
    );
  }
  assert.doesNotThrow(() => requireBrowserBridge('chatgpt'));
  for (const providerId of ['gemini', 'perplexity']) {
    assert.throws(() => requireBrowserBridge(providerId), /manual handoff only/);
  }
  assert.throws(() => requireBrowserBridge('unknown'));
});

test('ChatGPT adapter routing remains narrower than a provider page identity', () => {
  assert.equal(
    chatgptAddress('https://chat.openai.com/g/custom/c/task-1/?query=1#reply'),
    'https://chat.openai.com/g/custom/c/task-1',
  );
  assert.equal(chatgptAddress('https://chatgpt.com/?query=1', true), 'https://chatgpt.com');
  for (const url of [
    'https://chatgpt.com/',
    'https://chatgpt.com/settings',
    'https://chatgpt.com/c/task/extra',
    'https://chatgpt.com/c/local-chatgpt:task',
    'https://user@chatgpt.com/c/task',
    'https://gemini.google.com/app/task',
  ]) {
    assert.equal(chatgptAddress(url), undefined, url);
  }
});
