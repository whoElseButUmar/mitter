import { z } from 'zod';
import { extensionIdentitySchema, installedPackageSchema } from '../installation/contracts.mjs';
import { buildVerificationSchema } from '../build/contracts.mjs';

export function requireNativeTerminalSchema(runtime) {
  const schema = runtime.nativeTerminalCheckSchema;

  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      'The built native terminal schema is missing. Run pnpm build:host before terminal preflight.',
    );
  }

  return schema;
}

const pathSchema = z.string().min(1).describe('A local filesystem path; it may contain private information.');
const nodeVersionSchema = z
  .string()
  .regex(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  .describe('The Node.js version running this diagnostic, including its leading v.');
const platformSchema = z.string().min(1).describe('The Node.js operating system platform name.');
const architectureSchema = z.string().min(1).describe('The Node.js CPU architecture name.');
const errorSchema = z.string().min(1).describe('An actionable diagnostic failure message.');
const dependencySchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      name: z.string().min(1).describe('The dependency package checked by local resolution.'),
      status: z.literal('found').describe('The package resolves from the installation.'),
      path: pathSchema.describe('The resolved dependency entrypoint path.'),
    }),
    z.strictObject({
      name: z.string().min(1).describe('The dependency package checked by local resolution.'),
      status: z.literal('not-installed').describe('The package does not resolve from the installation.'),
      optional: z.boolean().describe('Whether this package is an optional local model runtime.'),
    }),
  ])
  .describe('Local dependency resolution without installation or network access.');
const assetSchema = z
  .strictObject({
    file: pathSchema.describe('An installation asset path relative to the repository root.'),
    status: z.enum(['found', 'missing']).describe('Whether this asset exists locally.'),
  })
  .describe('Presence of an installation asset, not a filesystem mutation.');
const productionCheckSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      name: z.literal('production-assets').describe('The production build consistency check.'),
      status: z.literal('passed').describe('Every required production asset was verified.'),
      detail: buildVerificationSchema,
    }),
    z.strictObject({
      name: z.literal('production-assets').describe('The production build consistency check.'),
      status: z.literal('failed').describe('The production assets failed verification.'),
      error: errorSchema,
    }),
    z.strictObject({
      name: z.literal('production-assets').describe('The production build consistency check.'),
      status: z.literal('not-built').describe('This installation has no built extension manifest.'),
      next: z.string().min(1).describe('The next build step for a source-only installation.'),
    }),
  ])
  .describe('Build consistency check and actionable failure or source-only guidance.');

const prerequisiteCheckSchema = z
  .strictObject({
    name: z
      .enum(['node-runtime', 'automatic-app-checks', 'native-registration'])
      .describe('The runtime, isolation or browser connection prerequisite inspected.'),
    status: z
      .enum(['passed', 'failed'])
      .describe('Whether this prerequisite was found; no runtime code is executed.'),
    detail: z.string().min(1).describe('Observed evidence and the next action, when needed.'),
  })
  .describe('Read-only prerequisite inspection, not a live host or sandbox execution check.');

export const preparationArgumentsSchema = z
  .array(
    z
      .enum(['--repair', '--check'])
      .describe('Inspect only, or explicitly authorize installer permission repair.'),
  )
  .max(1)
  .describe('Terminal preparation accepts one mode flag; absence means read-only inspection.');

export const doctorArgumentsSchema = z
  .array(z.enum(['--json', '--chromium']).describe('Print JSON or inspect the Chromium registration.'))
  .refine((args) => {
    return new Set(args).size === args.length;
  })
  .describe('The doctor CLI accepts no unknown or repeated flags.');

export const installationReportSchema = z
  .strictObject({
    product: z.literal('Miter').describe('The product inspected by this diagnostic.'),
    version: installedPackageSchema.shape.version,
    node: nodeVersionSchema,
    platform: platformSchema,
    architecture: architectureSchema,
    installation: pathSchema.describe('The inspected repository or installation root.'),
    dataDirectory: pathSchema.describe('The configured private Miter state directory.'),
    identity: extensionIdentitySchema,
    dependencies: z.array(dependencySchema).describe('Local dependency resolution results.'),
    assets: z.array(assetSchema).describe('Local build and installation asset presence.'),
    checks: z
      .array(z.union([productionCheckSchema, prerequisiteCheckSchema]))
      .describe('Production assets, runtime and native registration checks.'),
    networkRequested: z.literal(false).describe('Diagnostics never request network access.'),
    projectFilesChanged: z.literal(false).describe('Diagnostics never modify project files.'),
    guidance: z.array(z.string().min(1)).describe('Read-only follow-up and privacy guidance.'),
  })
  .describe('Read-only installation diagnostic JSON; paths may contain private information.');

/** Extend the host's actual runtime schema rather than duplicating native helper fields. */
export function terminalReportSchema(nativeTerminalCheckSchema) {
  const filesystemCheckSchema = z
    .strictObject({
      name: z.enum(['temporary-directory', 'shell']).describe('The filesystem prerequisite checked.'),
      status: z.literal('passed').describe('The prerequisite is accessible.'),
      path: pathSchema.describe('The canonical path of the accessible prerequisite.'),
    })
    .describe('An accessible shell executable or temporary directory.');
  const failedCheckSchema = z
    .strictObject({
      name: z
        .enum(['temporary-directory', 'shell', 'native-terminal-runtime'])
        .describe('The prerequisite that failed inspection.'),
      status: z.literal('failed').describe('The prerequisite could not be verified.'),
      error: errorSchema,
      cause: z
        .string()
        .max(1000)
        .optional()
        .describe('An underlying error message, limited to 1000 characters.'),
    })
    .describe('A prerequisite failure, including when the host build is unavailable.');
  let nativeCheckSchema = z.never();

  if (nativeTerminalCheckSchema !== undefined) {
    if (!(nativeTerminalCheckSchema instanceof z.ZodObject)) {
      throw new Error('Terminal reports need the native terminal object schema from the host build.');
    }

    nativeCheckSchema = nativeTerminalCheckSchema
      .safeExtend({
        name: z.literal('native-terminal-runtime').describe('The native terminal dependency check.'),
        status: z.literal('passed').describe('The selected binding and helper passed inspection.'),
      })
      .strict()
      .describe('The actual host terminal check with its diagnostic name and status.');
  }

  return z
    .strictObject({
      node: nodeVersionSchema,
      platform: platformSchema,
      architecture: architectureSchema,
      installation: pathSchema.describe('The inspected repository or installation root.'),
      checks: z
        .array(z.union([filesystemCheckSchema, failedCheckSchema, nativeCheckSchema]))
        .describe('Filesystem and native terminal prerequisite results.'),
      modifiedFiles: z.literal(false).describe('This inspection does not repair or change local files.'),
      spawnedProcesses: z.literal(false).describe('This inspection never launches a shell or PTY.'),
      guidance: z.string().min(1).describe('Prerequisite limits and unchanged security settings.'),
    })
    .describe('Read-only terminal prerequisites; never launches a shell or repairs permissions.');
}
