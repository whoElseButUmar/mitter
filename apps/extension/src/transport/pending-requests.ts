import type { RPCResponse } from '../schemas/messages.js';

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** Pending work belongs to one connection; no reconnect ever replays it. */
export class PendingRequests {
  private requests = new Map<string, PendingRequest>();

  send(id: string, timeoutMs: number, timeout: () => Error, post: () => void): Promise<unknown> {
    if (this.requests.has(id)) {
      return Promise.reject(
        new Error('A request with this ID is already pending. The duplicate operation was not sent.'),
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.requests.get(id) !== request) {
          return;
        }

        this.requests.delete(id);

        try {
          reject(timeout());
        } catch (error) {
          reject(error);
        }
      }, timeoutMs);
      const request: PendingRequest = { resolve, reject, timer };
      this.requests.set(id, request);

      try {
        post();
      } catch (error) {
        clearTimeout(timer);

        if (this.requests.get(id) === request) {
          this.requests.delete(id);
        }

        reject(error);
      }
    });
  }

  receive(response: RPCResponse): boolean {
    const request = this.requests.get(response.id);

    if (!request) {
      return false;
    }

    clearTimeout(request.timer);
    this.requests.delete(response.id);

    if (response.ok) {
      request.resolve(response.result);
    } else {
      request.reject(new Error(response.error));
    }

    return true;
  }

  rejectAll(error: Error): void {
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }

    this.requests.clear();
  }
}
