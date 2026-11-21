import { assetRequestSchema, validateAssetChunk, type AssetChunk } from './schemas/preview.js';
import { ViewRequestPort } from './transport/view-request-port.js';

/** One lightweight read-only connection. Reconnection never triggers execution. */
export class FilePreviewClient {
  private readonly connection = new ViewRequestPort(
    'miter-file-preview',
    'File window closed.',
    (detail) => detail || 'File connection closed. Reload to reconnect.',
  );

  request = async (method: string, params: Record<string, unknown>): Promise<AssetChunk> => {
    const request = assetRequestSchema.parse({
      id: crypto.randomUUID(),
      method,
      params,
    });
    const result = await this.connection.send(
      { ...request, params },
      35000,
      'File read timed out. Reload to try again.',
    );

    return validateAssetChunk(result, request.params);
  };

  close(): void {
    this.connection.close();
  }
}
