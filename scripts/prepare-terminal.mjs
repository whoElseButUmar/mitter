/** Installer-only permission normalization after explicit dependency approval.
 * No recursive chmod, sudo, security-setting changes, shell execution or network.
 */
import path from 'node:path';
import { z } from 'zod';
import { errorMessage, isMainModule, parseContract } from './helpers/runtime.mjs';
import { preparationArgumentsSchema, requireNativeTerminalSchema } from './diagnostics/contracts.mjs';

export function parsePreparationArguments(args) {
  const parsed = preparationArgumentsSchema.safeParse(args);

  if (!parsed.success) {
    throw new Error('Usage: node scripts/prepare-terminal.mjs [--check | --repair]', { cause: parsed.error });
  }

  return { repair: parsed.data.includes('--repair') };
}

async function prepareTerminal() {
  let options;

  try {
    options = parsePreparationArguments(process.argv.slice(2));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;

    return;
  }

  const root = path.resolve(import.meta.dirname, '..');

  try {
    const runtime = await import('../dist/apps/host/src/core/pty-runtime.js');
    const nativeTerminalCheckSchema = requireNativeTerminalSchema(runtime);
    const result = await runtime.prepareNativeTerminal({
      root,
      repair: options.repair,
    });
    const check = parseContract(
      nativeTerminalCheckSchema,
      result.check,
      'Invalid native terminal preflight result. Run pnpm build:host before retrying.',
    );

    console.log(
      `Native terminal preflight: node-pty ${check.version} · ${check.platform}/${check.architecture}`,
    );

    if (check.helper) {
      const helper = check.helper;

      console.log('Selected helper: ' + path.relative(root, helper.helper));

      if (helper.repaired) {
        console.log(
          `Repaired helper execute permission: ${helper.modeBefore} → ${helper.modeAfter}. ` +
            'Identical bytes; private local copy, pnpm store inode untouched.',
        );
      } else {
        console.log(`Helper executable: mode ${helper.modeAfter}. No repair needed.`);
      }

      console.log('Helper SHA-256: ' + helper.sha256);
    } else {
      console.log('Binding loaded. macOS spawn-helper repair is not applicable on this platform.');
    }

    console.log(
      'The actual PTY launch test is still required; this preflight alone does not prove ' +
        'a working terminal.',
    );
  } catch (error) {
    console.error('Native terminal preflight failed:', errorMessage(error));

    if (error instanceof Error && error.cause instanceof Error && !(error.cause instanceof z.ZodError)) {
      console.error('Underlying error:', error.cause.message.slice(0, 1000));
    }

    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  await prepareTerminal();
}
