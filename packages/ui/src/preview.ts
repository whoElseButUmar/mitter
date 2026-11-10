/** Local-only, size-bounded preview assembly. Never executes project source in the extension. */
export { loadAsset, isTextAsset, assetText, assetDataURL, localDependency } from './preview/assets.js';
export { markdownDocument, htmlDocument } from './preview/documents.js';
export {
  PreviewAssetSchema,
  PreviewChunkSchema,
  PreviewDocumentSchema,
  type PreviewAsset,
  type PreviewRPC,
} from './preview/schemas.js';
