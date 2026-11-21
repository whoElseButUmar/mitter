import type { Request } from '../../../../packages/protocol/src/index.js';
import { rpcResponseSchema } from '../schemas/messages.js';
import { errorMessage } from '../schemas/primitives.js';
import { PendingRequests } from './pending-requests.js';

type Connection = {
  port: chrome.runtime.Port;
  release: () => void;
};

/** File and terminal views open a port on demand. Lost requests are never replayed. */
export class ViewRequestPort {
  private current: Connection | undefined;
  private readonly pending = new PendingRequests();
  private closed = false;

  constructor(
    private readonly name: string,
    private readonly closedMessage: string,
    private readonly disconnectedMessage: (detail?: string) => string,
    private readonly onDisconnect?: () => void,
  ) {}

  private release(connection: Connection, reason: string): void {
    this.current = undefined;
    this.pending.rejectAll(new Error(reason));
    connection.release();
  }

  private disconnected(connection: Connection, reason: string): void {
    if (this.current === connection) {
      this.release(connection, reason);
      this.onDisconnect?.();
    }
  }

  private connect(): Connection {
    if (this.closed) {
      throw new Error(this.closedMessage);
    }

    if (this.current) {
      return this.current;
    }

    const port = chrome.runtime.connect({ name: this.name });
    const receive = (raw: unknown): void => {
      if (this.current !== connection) {
        return;
      }

      const response = rpcResponseSchema.safeParse(raw);
      if (response.success) {
        this.pending.receive(response.data);
      }
    };
    const disconnected = (): void => {
      this.disconnected(connection, this.disconnectedMessage(chrome.runtime.lastError?.message));
    };
    const connection: Connection = {
      port,
      release() {
        // Chrome can invalidate one listener before the other during extension reload.
        try {
          port.onMessage.removeListener(receive);
        } catch {}
        try {
          port.onDisconnect.removeListener(disconnected);
        } catch {}
        try {
          port.disconnect();
        } catch {}
      },
    };
    this.current = connection;
    try {
      port.onMessage.addListener(receive);
      port.onDisconnect.addListener(disconnected);
    } catch (error) {
      if (this.current === connection) {
        this.release(connection, errorMessage(error));
      }
      throw error;
    }

    return connection;
  }

  send(request: Request, timeoutMs: number, timeoutMessage: string): Promise<unknown> {
    const connection = this.connect();
    return this.pending.send(
      request.id,
      timeoutMs,
      () => new Error(timeoutMessage),
      () => {
        try {
          connection.port.postMessage(request);
        } catch {
          this.disconnected(connection, this.disconnectedMessage());
        }
      },
    );
  }

  close(reason = this.closedMessage): void {
    this.closed = true;
    if (this.current) {
      this.release(this.current, reason);
    }
  }
}
