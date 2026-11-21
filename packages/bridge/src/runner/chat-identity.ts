import type { Worker } from '../../../protocol/src/index.js';
import { messagePayload } from '../message-wire.js';
import { normalizeMessageText } from '../schemas/primitives.js';
import { chatgptAddress } from '../connections/chatgpt.js';

export function conversationURL(raw: string): string {
  const address = chatgptAddress(raw);
  if (address === undefined) {
    throw new Error('Choose a ChatGPT conversation, or let Mitter open a new one.');
  }
  return address;
}

export function chatStartURL(raw: string, allowNewChat = false): string {
  const address = chatgptAddress(raw, allowNewChat);
  if (address === undefined) {
    throw new Error('Choose a ChatGPT conversation, or let Mitter open a new one.');
  }
  return address;
}

export function normalizeMessage(text: string): string {
  return normalizeMessageText(text);
}

/** Older builds may have a different bootstrap template. Match the task
 * envelope and verbatim goal, not the version-dependent whole prompt. */
export function isTaskBootstrap(text: string, worker: Pick<Worker, 'id' | 'projectId' | 'goal'>): boolean {
  const payload = messagePayload(text);
  if (
    !payload.startsWith('You are collaborating with Mitter,') ||
    !payload.includes('GOAL: ' + worker.goal + '\n')
  ) {
    return false;
  }
  const hasField = (key: string, value: string): boolean => {
    const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('"' + key + '"\\s*:\\s*"' + escapedValue + '"').test(payload);
  };
  return (
    hasField('protocol', 'mitter/1') &&
    hasField('workerId', worker.id) &&
    hasField('projectId', worker.projectId) &&
    payload.includes('For THIS ChatGPT handoff')
  );
}
