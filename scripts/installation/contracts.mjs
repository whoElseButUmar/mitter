import { z } from 'zod';
import { packageManagerPattern, packageNamePattern, packageVersionPattern } from './bootstrap.mjs';

const versionSchema = z.string().regex(packageVersionPattern).describe('An exact package version pin.');
const packageNameSchema = z
  .string()
  .regex(packageNamePattern)
  .describe('An npm package name, not an option.');
const packageManagerSchema = z
  .string()
  .regex(packageManagerPattern)
  .describe('The pinned pnpm specifier passed to npx by the bootstrap installer.');
const modelRuntimesSchema = z
  .record(packageNameSchema, versionSchema)
  .refine((packages) => {
    return Object.keys(packages).length > 0;
  })
  .describe('Optional local inference libraries with exact package version pins.');

export const installedPackageSchema = z
  .object({
    name: z.string().min(1).describe('The installed project package name.'),
    version: versionSchema,
    packageManager: packageManagerSchema,
    mitter: z
      .object({
        modelRuntimes: modelRuntimesSchema,
      })
      .describe('Miter installation settings; unrelated settings are ignored.'),
  })
  .describe('Installed project metadata used by local diagnostics; unrelated package fields are ignored.');

const nativeHostNameSchema = z
  .string()
  .regex(/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/)
  .describe('A Chrome native messaging host name without path separators.');

export const extensionIdentitySchema = z
  .strictObject({
    name: z.string().min(1).describe('The stable extension display name.'),
    key: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .describe('The base64 public key used to derive the stable Chrome extension ID.'),
    extensionId: z
      .string()
      .regex(/^[a-p]{32}$/)
      .describe('The stable 32-letter Chrome extension ID; verify-build checks the key digest.'),
    nativeHost: nativeHostNameSchema,
  })
  .describe('Stable extension public key, Chrome extension ID and native messaging host identity.');

export const registrationArgumentsSchema = z
  .array(
    z.union([
      z
        .enum(['--chrome', '--chromium', '--portable', '--remove', '--help'])
        .describe('A supported browser, portability, removal or help flag.'),
      z
        .string()
        .startsWith('--manifest-dir=')
        .refine((argument) => {
          const directory = argument.slice('--manifest-dir='.length);

          return directory.trim().length > 0 && !directory.includes('\0');
        })
        .describe('An explicit manifest directory path, with no NUL characters.'),
    ]),
  )
  .refine((args) => {
    return new Set(args).size === args.length;
  })
  .refine((args) => {
    return (
      args.filter((argument) => {
        return argument.startsWith('--manifest-dir=');
      }).length <= 1
    );
  })
  .describe(
    'Native registration argv; flags and manifest overrides may not repeat. Chromium retains precedence over Chrome.',
  );

export const nativeManifestSchema = z
  .strictObject({
    name: nativeHostNameSchema,
    description: z.literal('Miter local project host').describe('The exact native host display description.'),
    path: z
      .string()
      .min(1)
      .refine((filename) => {
        return !filename.includes('\0');
      })
      .describe('The executable launcher path, with no NUL characters.'),
    type: z.literal('stdio').describe('Chrome must communicate through standard input and output.'),
    allowed_origins: z
      .array(
        z
          .string()
          .regex(/^chrome-extension:\/\/[a-p]{32}\/$/)
          .describe('The single approved extension origin, including its trailing slash.'),
      )
      .length(1)
      .describe('Exactly one extension may connect; wildcards and additional origins are forbidden.'),
  })
  .describe('Native messaging registration restricted to the single stable extension origin.');
