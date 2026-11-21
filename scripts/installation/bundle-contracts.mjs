import { z } from 'zod';
import { installedPackageSchema } from './contracts.mjs';

const relativePathSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine((value) => {
    return (
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.split('/').every((part) => {
        return part !== '' && part !== '.' && part !== '..';
      })
    );
  })
  .describe('A canonical relative bundle file path with no parent traversal.');
const hashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe('SHA-256 of exact local bytes; consistency, not a publisher signature.');
const fileSchema = z
  .union([
    z.strictObject({
      path: relativePathSchema,
      sha256: hashSchema,
      mode: z.number().int().min(0).max(0o777).describe('Copied regular-file permission bits.'),
    }),
    z.strictObject({
      path: relativePathSchema,
      target: z
        .string()
        .min(1)
        .max(1000)
        .describe('A relative symbolic link whose resolved target must stay inside the bundle.'),
    }),
  ])
  .describe('One checked regular file or confined dependency link.');

export const bundleManifestSchema = z
  .strictObject({
    format: z.literal(1).describe('Local macOS bundle format version.'),
    version: installedPackageSchema.shape.version,
    platform: z.literal('darwin').describe('This local installer supports macOS only.'),
    architecture: z
      .enum(['arm64', 'x64'])
      .describe('The installed Node and native dependencies must match this CPU architecture.'),
    node: z
      .string()
      .regex(/^26\.\d+\.\d+$|^(?:2[7-9]|[3-9]\d)\.\d+\.\d+$/)
      .describe('Bundled Node version, at least 26.'),
    files: z
      .array(fileSchema)
      .min(1)
      .max(30000)
      .describe('Closed sorted inventory, excluding this manifest.'),
  })
  .describe('Locally built, relocatable installation metadata; this is not signed distribution evidence.');

export const installationStateSchema = z
  .strictObject({
    format: z.literal(1).describe('Managed installation format version.'),
    release: hashSchema.describe('The retained release identified by its bundle manifest hash.'),
    version: installedPackageSchema.shape.version,
    repairId: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .optional()
      .describe('A unique repair-copy suffix; absent for the original hash-named release.'),
    extensionId: z
      .string()
      .regex(/^[a-p]{32}$/)
      .describe('The stable registered extension identity.'),
  })
  .describe('Ownership marker for a Miter-managed destination; it contains no user state.');

export const installArgumentsSchema = z
  .array(
    z.union([
      z.enum(['--chromium', '--help']).describe('A supported browser or help option.'),
      z
        .string()
        .startsWith('--destination=')
        .refine((argument) => {
          return argument.slice(14).trim().length > 0 && !argument.includes('\0');
        })
        .describe('Explicit local managed installation destination.'),
    ]),
  )
  .refine((args) => {
    return (
      new Set(
        args.map((argument) => {
          return argument.split('=')[0];
        }),
      ).size === args.length
    );
  })
  .describe('Installer CLI arguments with no unknown or repeated options.');

export const installationOwnerSchema = installationStateSchema
  .pick({ format: true, extensionId: true })
  .describe(
    'Ownership marker written before installation work, so interrupted first installs can be retried without claiming unrelated folders.',
  );
