import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ownedTemporaryDirectory } from './chrome-native.mjs';

export const journeyFolderName = 'Journey project';

/** Replace only the OS dialog in headless Chrome. The real host still validates both paths. */
export async function preparePickerHost(directory) {
  const root = await ownedTemporaryDirectory(directory);
  const desktop = new URL('../../dist/apps/host/src/core/desktop.js', import.meta.url).href;
  const service = new URL('../../dist/apps/host/src/core/service.js', import.meta.url).href;
  const native = new URL('../../dist/apps/host/src/native.js', import.meta.url).href;
  const hostScript = path.join(root, 'picker-host.mjs');
  const modelPath = path.join(root, 'Picker fixture.gguf');
  const projectPath = path.join(root, journeyFolderName);
  const fixture = `
    import * as desktop from ${JSON.stringify(desktop)};
    export { checkModelFile, revealProject } from ${JSON.stringify(desktop)};
    export function pickFolder(_execute, _platform, purpose) {
      const selected = purpose === 'parent' ? ${JSON.stringify(root)} : ${JSON.stringify(projectPath)};
      return desktop.pickFolder(async () => selected, process.platform, purpose);
    }
    export function pickModelFile() {
      return desktop.pickModelFile(async () => ${JSON.stringify(modelPath)});
    }
  `;
  const fixtureURL = 'data:text/javascript;base64,' + Buffer.from(fixture).toString('base64');
  const entry = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (context.parentURL === ${JSON.stringify(service)} && result.url === ${JSON.stringify(desktop)}) {
        return { url: ${JSON.stringify(fixtureURL)}, shortCircuit: true };
      }
      return result;
    } });
    await import(${JSON.stringify(native)});
  `;

  await writeFile(modelPath, '', { flag: 'wx', mode: 0o600 });
  await writeFile(hostScript, entry, { flag: 'wx', mode: 0o600 });
  return { hostScript, modelPath };
}
