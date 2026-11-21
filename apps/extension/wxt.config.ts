import { defineConfig } from 'wxt';
import solid from 'vite-plugin-solid';
import { enforceExplicitImportPolicy } from './build/import-policy';

export default defineConfig({
  // Keep WXT's implicit auto-import transform disabled. Shared packages use
  // ordinary identifiers such as `storage`; auto-importing them can inject
  // WXT-only modules from outside the extension package and break pnpm/Vite
  // resolution. All WXT APIs used by Miter are imported explicitly.
  imports: false,
  // Use the compiler directly. The optional WXT wrapper's 1.1.0
  // postinstall invokes its maintainer-only `buildc` command. We do not need
  // that wrapper or its auto-import presets. No dependency hook is bypassed.
  hooks: {
    // Clear the final catalog even if a future WXT module adds presets.
    // imports:false alone did not empty their effective auto-import catalog.
    'config:resolved'(wxt) {
      enforceExplicitImportPolicy(wxt.config.imports);
    },
  },
  vite: () => ({
    plugins: [solid()],
    // All legitimate UI imports use the extension's single Solid runtime.
    resolve: { dedupe: ['solid-js'] },
  }),
  manifest: {
    name: 'Miter — Local project runner',
    description: 'Local project workers with an opt-in automatic chat bridge. No cloud API required.',
    version: '1.0.0',
    version_name: '1.0.0-rc.61',
    minimum_chrome_version: '120',
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1CW4JvuJCVngLhbV+Za49ZFsyRMebQOZrDsBM7DnxFhuYKDTV70RPmdCDz0mae+vrQtz+jk01QP/9DwGAnUA/malASejG9BjJNXAiXyTv+wODZ8Mf8Ct5gBM1YK0W0vpSMcFfr+vIYrwg27OnuatKb3HKVLqO0woKaA21Okri73ibwI7/a1D77dr7iDiq0Bid5JVLHcignqkKteffSra3lO/gjQ6QO7ceWBrg3v+2qdTABWeLbR5UBtdnVn2uxrqhhpr+IJbr+Nu0ROs7JTXcjTcNmiYRPpr7ecm/2G1zG9mz1Bs1ElJVyH4ZArXVqHq+zR6RWr9Xs+ZXFBJMdz9CwIDAQAB',
    // Chromium marks fontSettings kFlagCannotBeOptional. Miter only calls
    // getFontList, gated by the user's local Use system fonts preference.
    // https://github.com/chromium/chromium/blob/main/chrome/common/extensions/permissions/chrome_api_permissions.cc
    permissions: ['nativeMessaging', 'sidePanel', 'storage', 'clipboardWrite', 'scripting', 'fontSettings'],
    optional_permissions: ['clipboardRead', 'notifications'],
    optional_host_permissions: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    action: { default_title: 'Open Miter' },
    commands: {
      'open-mitter': { suggested_key: { default: 'Ctrl+Shift+L' }, description: 'Open the Miter side panel' },
    },
    icons: { 16: 'icon-16.png', 32: 'icon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' },
    sandbox: { pages: ['preview-sandbox.html'] },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'none'; frame-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' blob:",
      sandbox:
        "sandbox allow-scripts; script-src 'self' 'unsafe-inline'; child-src 'self' blob: about:; object-src 'none'",
    },
  },
});
