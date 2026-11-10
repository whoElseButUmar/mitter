import type { RewriteRequest } from '../../../../packages/protocol/src/rewrite';
import { rewriteViewSchema } from './view-data';
import { callResult, type ViewRPC } from './rpc';

function waitForRead(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(new Error('Rewrite cancelled.'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, 1200);
    signal.addEventListener('abort', cancel, {
      once: true,
    });
    if (signal.aborted) {
      cancel();
    }
  });
}

export async function performDraftRewrite(
  request: RewriteRequest,
  signal: AbortSignal,
  dependencies: {
    rpc: ViewRPC;
    authorize: () => Promise<boolean>;
  },
): Promise<string> {
  if (request.provider === 'chatgpt' && !(await dependencies.authorize())) {
    throw new Error('ChatGPT access was not granted. Your draft is unchanged.');
  }
  if (signal.aborted) {
    throw new Error('Rewrite cancelled.');
  }
  const { rpc } = dependencies;
  const started = await callResult(rpc, rewriteViewSchema, 'rewrite.start', {
    request,
    consent: true,
  });

  const cancel = () => {
    void rpc('rewrite.cancel', {
      id: started.id,
    }).catch(() => {});
  };
  signal.addEventListener('abort', cancel, {
    once: true,
  });
  try {
    if (signal.aborted) {
      cancel();
      throw new Error('Rewrite cancelled.');
    }
    let result = started;
    const began = Date.now();
    while (result.state === 'waiting') {
      if (signal.aborted) {
        throw new Error('Rewrite cancelled.');
      }
      if (Date.now() - began > 190000) {
        cancel();
        throw new Error('The rewrite timed out. Your draft is unchanged.');
      }
      await waitForRead(signal);
      result = await callResult(rpc, rewriteViewSchema, 'rewrite.read', {
        id: started.id,
      });
    }
    if (signal.aborted) {
      throw new Error('Rewrite cancelled.');
    }
    if (result.state !== 'done' || typeof result.text !== 'string') {
      if ('error' in result && result.error) {
        throw new Error(result.error);
      }

      throw new Error('Rewrite cancelled.');
    }
    return result.text;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
