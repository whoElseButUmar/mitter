import path from 'node:path';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { errorMessage } from './types.js';
import { adaptPtyFactory } from './terminal/pty-adapter.js';
import type { PtyFactory } from './terminal/pty-adapter.js';
import {
  checkDarwinHelper,
  terminalBindingCandidates,
  TerminalRuntimeError,
  EXPECTED_VERSION,
  inside,
  helperCheckSchema,
  helperOptionsSchema,
} from './terminal/helper-check.js';
export {
  checkDarwinHelper,
  terminalBindingCandidates,
  isMachExecutable,
  TerminalRuntimeError,
  helperCheckSchema,
} from './terminal/helper-check.js';

export type { HelperCheck } from './terminal/helper-check.js';

export const nativeTerminalCheckSchema = z
  .strictObject({
    version: z
      .literal(EXPECTED_VERSION)
      .describe('The exact pinned native PTY version that passed inspection.'),
    platform: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .describe('The nonempty Node operating-system platform identifier.'),
    architecture: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .describe('The nonempty Node process architecture identifier.'),
    helper: helperCheckSchema
      .optional()
      .describe('Required matching helper inspection on macOS; absent elsewhere.'),
  })
  .superRefine((check, context) => {
    if (check.platform === 'darwin') {
      if (check.helper === undefined || check.helper.architecture !== check.architecture) {
        context.addIssue({
          code: 'custom',
          message: 'macOS terminal inspection requires the helper checked for this process architecture.',
          path: ['helper'],
        });
      }
    } else if (check.helper !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A macOS helper inspection cannot describe another terminal platform.',
        path: ['helper'],
      });
    }
  })
  .describe('Pinned native terminal inspection with exact platform/helper binding, before shell startup.');

export type NativeTerminalCheck = z.infer<typeof nativeTerminalCheckSchema>;
const packageSchema = z
  .object({
    name: z.string().describe('The native dependency package name; it must be node-pty.'),
    version: z.string().describe('The dependency version checked against the pinned release.'),
  })
  .describe('Native PTY package identity; only the pinned dependency is accepted.');

export const nativeTerminalOptionsSchema = helperOptionsSchema
  .omit({ arch: true })
  .extend({
    root: z
      .string()
      .optional()
      .describe('An explicit installation root, required for any dependency repair.'),
  })
  .describe('Local native-terminal configuration, parsed before dependency loading or repair.');

export type NativeTerminalOptions = z.infer<typeof nativeTerminalOptionsSchema>;

export async function prepareNativeTerminal(options: NativeTerminalOptions = {}): Promise<{
  factory: PtyFactory;
  check: NativeTerminalCheck;
}> {
  const parsed = nativeTerminalOptionsSchema.safeParse(options);

  if (!parsed.success) {
    throw new TerminalRuntimeError(
      'PTY_OPTIONS',
      'Invalid native terminal options. No repair was attempted.',
      {
        cause: parsed.error,
      },
    );
  }

  options = parsed.data;

  if (options.repair && !options.root) {
    throw new TerminalRuntimeError('PTY_REPAIR_SCOPE', 'Repair requires an explicit installation root.');
  }

  let requireLocation = import.meta.url;

  if (options.root) {
    requireLocation = path.join(await fs.realpath(options.root), 'package.json');
  }

  const require = createRequire(requireLocation);
  let entry: string;
  let packageInfo: z.infer<typeof packageSchema>;

  try {
    entry = require.resolve('node-pty/package.json');
    packageInfo = packageSchema.parse(JSON.parse(await fs.readFile(entry, 'utf8')));
  } catch (error) {
    throw new TerminalRuntimeError(
      'PTY_NOT_INSTALLED',
      'node-pty is not installed. Finish setup and approve its build before ' + 'opening a terminal.',
      {
        cause: error,
      },
    );
  }

  if (packageInfo.name !== 'node-pty' || packageInfo.version !== EXPECTED_VERSION) {
    throw new TerminalRuntimeError(
      'PTY_VERSION',
      `Expected node-pty ${EXPECTED_VERSION}, found ${
        packageInfo.version
      }. Use the pinned candidate dependencies.`,
    );
  }

  const packageRoot = await fs.realpath(path.dirname(entry));

  if (options.repair) {
    if (!options.root) {
      throw new TerminalRuntimeError('PTY_REPAIR_SCOPE', 'Repair requires an explicit installation root.');
    }

    const root = await fs.realpath(options.root);
    const modules = path.join(root, 'node_modules');

    if ((await fs.realpath(modules)) !== modules || !inside(modules, packageRoot)) {
      throw new TerminalRuntimeError(
        'PTY_REPAIR_SCOPE',
        'Refusing to modify a dependency outside this installation’s local ' + 'node_modules.',
      );
    }
  }

  let factory: PtyFactory;

  try {
    const loaded: unknown = require('node-pty');
    factory = adaptPtyFactory(loaded);
  } catch (error) {
    throw new TerminalRuntimeError(
      'PTY_BINDING_LOAD',
      `The node-pty native binding did not load (${
        process.platform
      }/${process.arch}, Node ${process.versions.node}). ` +
        'Reinstall/approve its build using this Node version.',
      {
        cause: error,
      },
    );
  }

  const check: NativeTerminalCheck = {
    version: EXPECTED_VERSION,
    platform: process.platform,
    architecture: process.arch,
  };

  if (process.platform === 'darwin') {
    const candidates = terminalBindingCandidates(packageRoot, process.platform, process.arch);
    const loaded = candidates.filter((file) => require.cache[file]);
    const binding = loaded[0];

    if (loaded.length !== 1 || binding === undefined) {
      throw new TerminalRuntimeError(
        'PTY_BINDING_SELECTION',
        'Could not uniquely identify node-pty’s loaded native binding. No ' +
          'helper permissions were changed.',
      );
    }

    if (packageRoot.includes('app.asar') || packageRoot.includes('node_modules.asar')) {
      throw new TerminalRuntimeError(
        'PTY_HELPER_PATH',
        'This source installer does not support an asar path. Extract Miter ' + 'into an ordinary directory.',
      );
    }

    const helperOptions: { arch: string; repair?: boolean } = {
      arch: process.arch,
    };

    if (options.repair !== undefined) {
      helperOptions.repair = options.repair;
    }

    check.helper = await checkDarwinHelper(packageRoot, binding, helperOptions);
  }

  return {
    check: nativeTerminalCheckSchema.parse(check),
    factory: {
      spawn(shell, args, settings) {
        try {
          return factory.spawn(shell, args, settings);
        } catch (error) {
          const nativeMessage = errorMessage(error);
          let detail = nativeMessage.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 180);
          let helper = '';

          if (nativeMessage.includes('posix_spawnp')) {
            detail = 'posix_spawnp failed.';
          }

          if (check.helper) {
            helper = ` Helper passed inspection (${check.helper.modeAfter}, ${check.architecture}).`;
          }

          throw new TerminalRuntimeError(
            'PTY_SPAWN_FAILED',
            `The local terminal could not start: ${detail}${helper} ` +
              ('Run node scripts/terminal-doctor.mjs from the installation folder for ' +
                'a read-only launch diagnostic. ') +
              'No spawn was retried.',
            {
              cause: error,
            },
          );
        }
      },
    },
  };
}

export async function loadPtyRuntime(): Promise<PtyFactory> {
  return (await prepareNativeTerminal()).factory;
}
