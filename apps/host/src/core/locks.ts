/** FIFO workspace/model locks. An aborted waiter leaves immediately without
 * letting its successor overtake the current owner. */

export class Locks {
  private tails = new Map<string, Promise<void>>();
  async using<T>(key: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const before = this.tails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const own = new Promise<void>((resolve) => {
      release = resolve;
    });

    if (!release) {
      throw new Error('Lock resolver was not initialized.');
    }

    const releaseOwner = release;
    // Keep the predecessor in the chain even if this waiter leaves early.
    const tail = before.then(() => own);
    this.tails.set(key, tail);
    let abort: (() => void) | undefined;

    try {
      await Promise.race([
        before,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason ?? new Error('Lock wait aborted.'));
          signal.addEventListener('abort', abort, {
            once: true,
          });

          if (signal.aborted) {
            abort();
          }
        }),
      ]);
      signal.throwIfAborted();

      return await fn();
    } finally {
      if (abort) {
        signal.removeEventListener('abort', abort);
      }
      releaseOwner();
      // Removing the tail early would create a parallel owner for a later
      // caller. Only remove it once ALL predecessors have really released.
      void tail.then(() => {
        if (this.tails.get(key) === tail) {
          this.tails.delete(key);
        }
      });
    }
  }
}
