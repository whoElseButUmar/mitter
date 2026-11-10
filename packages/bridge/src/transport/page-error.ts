export class PageBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PageBridgeError';
  }
}
