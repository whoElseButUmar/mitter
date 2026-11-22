/** Static permission/CSP regression policy. This is not a vulnerability scanner
 * or an independent security audit. It prevents accidentally broadening the
 * existing extension boundary in the built manifest or source configuration. */
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { parseSync, Visitor } from 'rolldown/utils';
import { z } from 'zod';
import { securityManifestSchema } from './build/contracts.mjs';
import { errorMessage, isMainModule, parseContract } from './helpers/runtime.mjs';

const requiredPermissions = [
  'nativeMessaging',
  'sidePanel',
  'storage',
  'clipboardWrite',
  'scripting',
  'fontSettings',
  'offscreen',
];
const optionalPermissions = ['clipboardRead', 'notifications'];
const optionalOrigins = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];

function exactSandboxValues(allowed, description) {
  return z
    .array(z.enum(allowed).describe('An explicitly approved sandbox capability or source expression.'))
    .length(allowed.length)
    .refine((values) => {
      return new Set(values).size === values.length;
    }, 'Each approved sandbox directive value must occur exactly once.')
    .describe(description);
}

const previewSandboxDirectivesSchema = z
  .strictObject({
    sandbox: exactSandboxValues(
      ['allow-scripts'],
      'Scripts may run without restoring the preview origin or granting other sandbox privileges.',
    ),
    'script-src': exactSandboxValues(
      ["'self'", "'unsafe-inline'"],
      'Only packaged and inline preview scripts are approved; evaluation and remote code are not.',
    ),
    'child-src': exactSandboxValues(
      ["'self'", 'blob:', 'about:'],
      'Preview children may use only packaged, Blob, or about URLs.',
    ),
    'object-src': exactSandboxValues(["'none'"], 'Plugin content remains disabled in the preview.'),
  })
  .describe('Exactly the four sandbox CSP directives approved in the WXT manifest.');

export const previewSandboxPolicySchema = z
  .string()
  .describe('The preview sandbox content security policy text from a source or built Chrome manifest.')
  .transform((policy, context) => {
    const directives = Object.create(null);

    for (const rule of policy.split(';')) {
      // CSP uses ASCII whitespace; Unicode separators must not disguise ignored browser directives.
      const [name, ...values] = rule.split(/[ \t\n\f\r]+/).filter((value) => {
        return value.length > 0;
      });

      if (name === undefined) {
        continue;
      }

      const directive = name.toLowerCase();

      if (Object.hasOwn(directives, directive)) {
        context.addIssue({
          code: 'custom',
          message: 'Duplicate preview sandbox CSP directive: ' + directive,
        });

        return z.NEVER;
      }

      directives[directive] = values;
    }

    return directives;
  })
  .pipe(previewSandboxDirectivesSchema)
  .describe('The exact approved preview sandbox CSP, with no missing, duplicate, or extra directives.');

function checkAllowedValues(actual, allowed, label) {
  const unexpectedValue = actual.some((value) => {
    return !allowed.includes(value);
  });
  const duplicateValue = new Set(actual).size !== actual.length;

  if (unexpectedValue || duplicateValue) {
    throw new Error('Unexpected ' + label + '. Review any permission expansion explicitly.');
  }
}

export function checkManifestSecurity(value) {
  // Chromium's permission rules apply to both source declarations and generated manifests.
  const manifest = securityManifestSchema.parse(value);

  if (manifest.optional_permissions?.includes('fontSettings')) {
    throw new Error(
      'fontSettings cannot be optional in Chrome. Declare it in permissions; the system-font toggle is an application preference.',
    );
  }

  checkAllowedValues(manifest.permissions, requiredPermissions, 'permissions');

  for (const permission of requiredPermissions) {
    if (!manifest.permissions.includes(permission)) {
      throw new Error('Missing required permission: ' + permission);
    }
  }

  const declaredOptionalPermissions = manifest.optional_permissions ?? [];
  const declaredOptionalOrigins = manifest.optional_host_permissions ?? [];

  checkAllowedValues(declaredOptionalPermissions, optionalPermissions, 'optional permissions');
  checkAllowedValues(declaredOptionalOrigins, optionalOrigins, 'optional website access');

  for (const permission of optionalPermissions) {
    if (!declaredOptionalPermissions.includes(permission)) {
      throw new Error('Missing optional permission: ' + permission);
    }
  }

  for (const origin of optionalOrigins) {
    if (!declaredOptionalOrigins.includes(origin)) {
      throw new Error('Missing optional website access: ' + origin);
    }
  }

  if (
    manifest.host_permissions?.length ||
    manifest.externally_connectable ||
    manifest.content_scripts?.length
  ) {
    throw new Error(
      'Persistent site injection, required host access, or external messaging is not approved.',
    );
  }

  if (!manifest.sandbox?.pages?.includes('preview-sandbox.html')) {
    throw new Error('The preview sandbox must remain isolated.');
  }

  const extensionPolicy = manifest.content_security_policy?.extension_pages;

  if (extensionPolicy === undefined) {
    throw new Error('Missing extension CSP.');
  }

  const directives = new Map();

  for (const rule of extensionPolicy.split(';')) {
    const trimmedRule = rule.trim();

    if (!trimmedRule) {
      continue;
    }

    const [name, ...values] = trimmedRule.split(/\s+/);

    if (directives.has(name)) {
      throw new Error('Duplicate CSP directive: ' + name);
    }

    directives.set(name, values);
  }

  for (const [name, values] of [
    ['script-src', ["'self'"]],
    ['object-src', ["'none'"]],
  ]) {
    if (JSON.stringify(directives.get(name)) !== JSON.stringify(values)) {
      throw new Error('Unsafe ' + name + ' policy.');
    }
  }

  for (const name of ['frame-src', 'connect-src']) {
    const values = directives.get(name);

    if (
      !values ||
      values.some((value) => {
        return !["'self'", 'blob:'].includes(value);
      })
    ) {
      throw new Error('Unsafe ' + name + ' policy.');
    }
  }

  parseContract(
    previewSandboxPolicySchema,
    manifest.content_security_policy?.sandbox,
    'Unexpected preview sandbox privileges or CSP directives. ' +
      'Keep the approved policy from apps/extension/wxt.config.ts; review any change explicitly.',
  );

  return {
    permissions: manifest.permissions.length,
    optionalPermissions: declaredOptionalPermissions.length,
    websiteAccess: 'optional',
    remoteExtensionCode: false,
  };
}

export async function sourceManifest(root) {
  const source = await readFile(path.join(root, 'apps/extension/wxt.config.ts'), 'utf8');
  const parsed = parseSync('wxt.config.ts', source);

  if (parsed.errors.length > 0) {
    throw new Error('Cannot parse the extension manifest configuration.');
  }

  const candidates = [];
  const visitor = new Visitor({
    Property(node) {
      const name = node.key.name ?? node.key.value;

      if (name === 'manifest' && !node.computed && !node.method && !node.shorthand) {
        candidates.push(node.value);
      }
    },
  });

  visitor.visit(parsed.program);

  if (candidates.length !== 1) {
    throw new Error('Cannot identify a unique literal extension manifest.');
  }

  return manifestLiteral(candidates[0]);
}

function manifestLiteral(node) {
  const wrappers = ['TSAsExpression', 'TSTypeAssertion', 'TSSatisfiesExpression', 'ParenthesizedExpression'];

  if (wrappers.includes(node?.type)) {
    return manifestLiteral(node.expression);
  }

  if (node?.type === 'Literal' && ['string', 'number', 'boolean'].includes(typeof node.value)) {
    return node.value;
  }

  if (node?.type === 'ArrayExpression') {
    return node.elements.map(manifestLiteral);
  }

  if (node?.type === 'ObjectExpression') {
    const value = {};

    for (const property of node.properties) {
      if (
        property.type !== 'Property' ||
        property.computed ||
        property.method ||
        property.shorthand ||
        property.kind !== 'init'
      ) {
        throw new Error('Dynamic manifest fields need explicit security review.');
      }

      const name = property.key.name ?? property.key.value;

      if (typeof name !== 'string' && typeof name !== 'number') {
        throw new Error('Dynamic manifest fields need explicit security review.');
      }

      if (Object.hasOwn(value, name)) {
        throw new Error('Duplicate manifest field.');
      }

      Object.defineProperty(value, name, {
        value: manifestLiteral(property.value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    return value;
  }

  throw new Error('Nonliteral manifest field cannot pass the static permission check.');
}

export async function checkSecurityPolicy(root) {
  const result = checkManifestSecurity(await sourceManifest(root));
  const publicDirectory = path.join(root, 'apps/extension/public');
  let pagesChecked = 0;

  for (const filename of await readdir(publicDirectory)) {
    if (!filename.endsWith('.html')) {
      continue;
    }

    const source = await readFile(path.join(publicDirectory, filename), 'utf8');

    pagesChecked++;

    for (const match of source.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      if (/^(?:[a-z]+:|\/\/)/i.test(match[1])) {
        throw new Error('Remote script in extension page: ' + filename);
      }
    }
  }

  return { ...result, staticPagesChecked: pagesChecked };
}

if (isMainModule(import.meta.url)) {
  try {
    const result = await checkSecurityPolicy(path.resolve(import.meta.dirname, '..'));

    console.log('Security policy passed:', result);
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
