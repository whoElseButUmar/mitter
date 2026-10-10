/**
 * WXT 0.21 resolves `imports: false` to an options object. Framework modules
 * then append presets to that object. Its unimport build plugin receives those
 * presets even when WXT's `disabled` flag is true. Run this in the user
 * config:resolved hook (AFTER framework modules) to leave no injectable names.
 *
 * Do not give framework-free shared code a fake Solid dependency, externalize
 * Solid, or hoist dependencies to hide unexpected generated imports.
 */
export function enforceExplicitImportPolicy(options: unknown): void {
  // Older WXT versions retained false instead of a resolved options object.
  if (options === false) return;
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Miter build: unsupported WXT import options; explicit imports cannot be verified.');
  }
  Object.assign(options, {
    disabled: true,
    autoImport: false,
    imports: [],
    presets: [],
    dirs: [],
    addons: [],
  });
}
