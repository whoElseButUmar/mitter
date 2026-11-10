declare global {
  var __mitterDomReaderDigestGate:
    { inspect(): { calls: number; held: boolean }; release(): void } | undefined;
}

// These functions are serialized only into the disposable extension's own
// ISOLATED top frame. They change scheduling, never WebCrypto's digest bytes.
export function installDomReaderDigestGate(): void {
  if (globalThis.__mitterDomReaderDigestGate) {
    throw new Error('A DOM-reader digest gate is already installed.');
  }

  const originalDescriptor = Object.getOwnPropertyDescriptor(crypto.subtle, 'digest');
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let held = true;
  const restore = (): void => {
    if (originalDescriptor) {
      Object.defineProperty(crypto.subtle, 'digest', originalDescriptor);
    } else {
      Reflect.deleteProperty(crypto.subtle, 'digest');
    }
  };

  Object.defineProperty(crypto.subtle, 'digest', {
    configurable: true,
    value: async (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
      const result = await digest(algorithm, data);
      calls++;
      await completion;
      return result;
    },
  });
  globalThis.__mitterDomReaderDigestGate = {
    inspect: () => ({ calls, held }),
    release: () => {
      restore();
      held = false;
      release?.();
      Reflect.deleteProperty(globalThis, '__mitterDomReaderDigestGate');
    },
  };
}

export function inspectDomReaderDigestGate(): { calls: number; held: boolean } {
  const gate = globalThis.__mitterDomReaderDigestGate;
  if (!gate) {
    return { calls: 0, held: false };
  }
  return gate.inspect();
}

export function releaseDomReaderDigestGate(): void {
  globalThis.__mitterDomReaderDigestGate?.release();
}
