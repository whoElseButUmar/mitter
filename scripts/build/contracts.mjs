import { z } from 'zod';
import { extensionIdentitySchema, installedPackageSchema } from '../installation/contracts.mjs';
import { packageNamePattern } from '../installation/bootstrap.mjs';
import { fontMetadataSchema } from '../fonts/contracts.mjs';

export const buildPackageSchema = installedPackageSchema
  .pick({ version: true })
  .describe(
    'The source package version used to compare extension and native host builds; unrelated fields are ignored.',
  );

const dependencyVersionsSchema = z
  .record(
    z.string().regex(packageNamePattern).describe('An npm dependency package name.'),
    z.string().min(1).describe('The dependency version specifier declared by the extension.'),
  )
  .describe(
    'Declared npm package names and version specifiers; the import policy checks the compiler pin separately.',
  );

export const extensionPackageSchema = z
  .object({
    dependencies: dependencyVersionsSchema
      .optional()
      .describe('Runtime dependency declarations, if present.'),
    devDependencies: dependencyVersionsSchema
      .optional()
      .describe('Build dependency declarations, if present.'),
  })
  .describe(
    'Extension dependencies inspected for the direct Solid compiler and forbidden framework wrapper; unrelated fields are ignored.',
  );

export const securityManifestSchema = z
  .object({
    permissions: z
      .array(z.string().min(1).describe('A Chrome API permission name.'))
      .describe('Required Chrome API permissions.'),
    optional_permissions: z
      .array(z.string().min(1).describe('An optional Chrome API permission name.'))
      .optional()
      .describe('Chrome API permissions requested only with user consent.'),
    optional_host_permissions: z
      .array(z.string().min(1).describe('An optional website match pattern.'))
      .optional()
      .describe('Website match patterns requested only with user consent.'),
    host_permissions: z
      .array(z.string().min(1).describe('A required website match pattern.'))
      .optional()
      .describe('Required website access, which the security policy forbids.'),
    externally_connectable: z
      .object({
        ids: z.array(z.string().min(1)).optional().describe('Extensions allowed to send external messages.'),
        matches: z.array(z.string().min(1)).optional().describe('Sites allowed to send external messages.'),
        accepts_tls_channel_id: z.boolean().optional().describe('Whether TLS channel IDs are accepted.'),
      })
      .optional()
      .describe('External messaging access, which the security policy forbids.'),
    content_scripts: z
      .array(
        z
          .object({
            matches: z.array(z.string().min(1)).describe('Sites targeted by persistent injection.'),
            js: z
              .array(z.string().min(1))
              .optional()
              .describe('Persistently injected JavaScript asset paths.'),
            css: z
              .array(z.string().min(1))
              .optional()
              .describe('Persistently injected stylesheet asset paths.'),
          })
          .describe('A persistent content-script declaration.'),
      )
      .optional()
      .describe('Persistent site injection, which the security policy forbids.'),
    sandbox: z
      .object({
        pages: z
          .array(z.string().min(1).describe('A sandboxed extension page asset path.'))
          .optional()
          .describe('Pages that must run outside the privileged extension context.'),
      })
      .optional()
      .describe('Extension pages isolated from the privileged extension context.'),
    content_security_policy: z
      .object({
        extension_pages: z.string().optional().describe('The privileged extension page CSP.'),
        sandbox: z.string().optional().describe('The isolated preview page CSP.'),
      })
      .optional()
      .describe('Content security policies for privileged and sandboxed pages.'),
  })
  .describe(
    'Source or built Chrome manifest fields checked by the security policy; unrelated manifest fields are ignored.',
  );

export const buildManifestSchema = securityManifestSchema
  .extend({
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .describe('The three-part release version stored in the Chrome manifest.'),
    version_name: z
      .string()
      .min(1)
      .optional()
      .describe('The full source version, including a prerelease suffix.'),
    key: extensionIdentitySchema.shape.key
      .optional()
      .describe('The public key that determines the stable Chrome extension ID.'),
  })
  .describe(
    'Built extension identity, version and security fields required before native host registration.',
  );

export const buildVerificationSchema = z
  .strictObject({
    version: buildPackageSchema.shape.version.describe(
      'The verified source and native host release version.',
    ),
    extensionId: extensionIdentitySchema.shape.extensionId,
    terminalFont: fontMetadataSchema,
    bundleModulesChecked: z
      .number()
      .int()
      .nonnegative()
      .describe('The number of packaged JavaScript modules inspected for unbundled imports.'),
    pageSHA256: fontMetadataSchema.shape.sha256.describe(
      'The SHA-256 digest of the exact packaged page bridge bytes.',
    ),
  })
  .describe('Verified host, extension, page bridge and font assets reported by build diagnostics.');
