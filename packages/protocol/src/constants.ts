/** Protocol identity and transport limits. */
export const APP_VERSION = '1.0.0-rc.21';
export const VERSION = 'mitter/1' as const;
export const MAX_FRAME = 800_000;
export const MAX_TEXT = 120_000;

/** The script/native-manifest mirror is brand/extension-identity.json. Changing
 * either identity requires re-registering the host and reloading the extension. */
export const EXTENSION_ID = 'mclgchkiejnomabbnglaodgnmfhhipep';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
export const NATIVE_HOST_NAME = 'ai.mitter.host';
