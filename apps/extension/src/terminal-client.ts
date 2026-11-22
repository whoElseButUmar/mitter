import { auxiliaryPort } from './transport/build-connection.js';
import { TERMINAL_PORT } from '../../../packages/terminal/src/protocol.js';
import {
  parseTerminalResult,
  terminalRequestSchema,
  type TerminalRpcMethod,
  type TerminalRpcResult,
} from './schemas/terminal.js';
import { ViewRequestPort } from './transport/view-request-port.js';

export class TerminalClient {
  private readonly connection: ViewRequestPort;

  constructor(disconnected: () => void) {
    this.connection = new ViewRequestPort(
      auxiliaryPort(TERMINAL_PORT),
      'Terminal view closed. No input was sent.',
      () => 'Terminal disconnected. Input was not replayed.',
      disconnected,
    );
  }

  request<Method extends TerminalRpcMethod>(
    method: Method,
    params?: Record<string, unknown>,
  ): Promise<TerminalRpcResult<Method>>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const request = terminalRequestSchema.parse({
      id: crypto.randomUUID(),
      method,
      params,
    });
    const result = await this.connection.send(
      request,
      15000,
      'Terminal request timed out. Input was not replayed.',
    );

    return parseTerminalResult(request.method, result);
  }

  close(): void {
    this.connection.close('Terminal view closed.');
  }
}
