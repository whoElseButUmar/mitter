import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import {
  checkManifestSecurity,
  checkSecurityPolicy,
  previewSandboxPolicySchema,
  sourceManifest,
} from '../check-security-policy.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const manifest = await sourceManifest(repositoryRoot);
const approvedPolicy =
  "sandbox allow-scripts; script-src 'self' 'unsafe-inline'; child-src 'self' blob: about:; object-src 'none'";
const approvedDirectives = {
  sandbox: ['allow-scripts'],
  'script-src': ["'self'", "'unsafe-inline'"],
  'child-src': ["'self'", 'blob:', 'about:'],
  'object-src': ["'none'"],
};

function manifestWithSandbox(sandbox) {
  return {
    ...manifest,
    content_security_policy: { ...manifest.content_security_policy, sandbox },
  };
}

function rejectSandboxPolicy(policy) {
  assert.throws(
    () => {
      checkManifestSecurity(manifestWithSandbox(policy));
    },
    (error) => {
      assert.match(error.message, /Unexpected preview sandbox privileges or CSP directives/);
      assert.ok(error.cause instanceof z.ZodError);
      assert.doesNotMatch(error.message, /invalid_type|unrecognized_keys/);

      return true;
    },
    policy,
  );
}

test('the shared sandbox schema preserves the exact current WXT policy without changing the manifest', () => {
  const before = structuredClone(manifest);

  assert.equal(manifest.content_security_policy.sandbox, approvedPolicy);
  assert.deepEqual(previewSandboxPolicySchema.parse(approvedPolicy), approvedDirectives);
  assert.equal(typeof previewSandboxPolicySchema.description, 'string');
  assert.equal(checkManifestSecurity(manifest).remoteExtensionCode, false);
  assert.deepEqual(manifest, before);
});

test('sandbox validation accepts equivalent ordering, ASCII whitespace, and trailing separators', () => {
  for (const policy of [
    approvedPolicy + ';',
    " ;\nOBJECT-SRC\t'none'; CHILD-SRC about: blob: 'self';\nSCRIPT-SRC 'unsafe-inline' 'self'; SANDBOX allow-scripts; ; ",
    approvedPolicy.replaceAll(' ', '\t\r\n\f'),
  ]) {
    assert.equal(checkManifestSecurity(manifestWithSandbox(policy)).remoteExtensionCode, false);
  }
});

test('sandbox script sources reject evaluation, remote origins, schemes, and alternate code sources', () => {
  for (const source of [
    "'unsafe-eval'",
    "'wasm-unsafe-eval'",
    'https://example.com',
    'http://example.com',
    'https:',
    '*',
    'blob:',
    'data:',
    "'strict-dynamic'",
  ]) {
    rejectSandboxPolicy(approvedPolicy.replace("script-src 'self'", 'script-src ' + source + " 'self'"));
  }
});

test('sandbox capabilities reject origin restoration and other unapproved privileges', () => {
  for (const capability of [
    'allow-same-origin',
    'allow-popups',
    'allow-forms',
    'allow-top-navigation',
    'allow-downloads',
  ]) {
    rejectSandboxPolicy(
      approvedPolicy.replace('sandbox allow-scripts', 'sandbox allow-scripts ' + capability),
    );
  }
});

test('sandbox validation requires every approved directive and its complete exact values', () => {
  for (const [name, values] of Object.entries(approvedDirectives)) {
    const directive = name + ' ' + values.join(' ');

    rejectSandboxPolicy(approvedPolicy.replace(directive, ''));
    rejectSandboxPolicy(approvedPolicy.replace(directive, name));
  }

  for (const policy of [
    '',
    "sandbox allow-scripts; script-src 'self' 'unsafe-inline'",
    approvedPolicy.replace("script-src 'self' 'unsafe-inline'", "script-src 'self'"),
    approvedPolicy.replace("child-src 'self' blob: about:", "child-src 'self' blob:"),
    approvedPolicy.replace(
      "child-src 'self' blob: about:",
      "child-src 'self' blob: about: https://example.com",
    ),
    approvedPolicy.replace("object-src 'none'", "object-src 'self'"),
    approvedPolicy.replace("object-src 'none'", 'object-src *'),
    approvedPolicy.replace('; script-src', ', script-src'),
  ]) {
    rejectSandboxPolicy(policy);
  }
});

test('sandbox validation rejects alternate script directives and every unknown directive', () => {
  for (const directive of [
    'script-src-elem https://example.com',
    "script-src-elem 'self'",
    "script-src-attr 'unsafe-inline'",
    'default-src *',
    'worker-src https://example.com',
    'frame-src https://example.com',
    'connect-src https://example.com',
    "unreviewed-src 'self'",
    '__proto__ *',
    "constructor 'self'",
    "toString 'self'",
  ]) {
    rejectSandboxPolicy(approvedPolicy + '; ' + directive);
  }
});

test('sandbox validation rejects repeated known, case-insensitive, conflicting, and unknown directives', () => {
  for (const [name, values] of Object.entries(approvedDirectives)) {
    const directive = name + ' ' + values.join(' ');

    rejectSandboxPolicy(approvedPolicy + '; ' + directive);
    rejectSandboxPolicy(approvedPolicy + '; ' + directive.toUpperCase());
  }

  for (const directive of [
    "script-src 'none'",
    'sandbox allow-same-origin',
    "unreviewed-src 'self'; unreviewed-src 'self'",
  ]) {
    rejectSandboxPolicy(approvedPolicy + '; ' + directive);
  }

  assert.throws(
    () => {
      checkManifestSecurity(manifestWithSandbox(approvedPolicy + "; SCRIPT-SRC 'none'"));
    },
    (error) => {
      assert.ok(error.cause instanceof z.ZodError);
      assert.equal(error.cause.issues[0].message, 'Duplicate preview sandbox CSP directive: script-src');

      return true;
    },
  );
});

test('sandbox validation rejects duplicate approved tokens rather than treating them as complete sets', () => {
  for (const policy of [
    approvedPolicy.replace('sandbox allow-scripts', 'sandbox allow-scripts allow-scripts'),
    approvedPolicy.replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'self'"),
    approvedPolicy.replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'self'"),
    approvedPolicy.replace("child-src 'self' blob: about:", "child-src 'self' blob: blob:"),
    approvedPolicy.replace("object-src 'none'", "object-src 'none' 'none'"),
  ]) {
    rejectSandboxPolicy(policy);
  }
});

test('sandbox validation does not interpret Unicode whitespace as browser CSP separators', () => {
  for (const policy of [
    approvedPolicy.replace('sandbox allow-scripts', 'sandbox\u00a0allow-scripts'),
    approvedPolicy.replace('script-src ', 'script-src\u00a0'),
    approvedPolicy.replace('; script-src', ';\u00a0script-src'),
    approvedPolicy.replace('script-src ', 'script-src\u000b'),
  ]) {
    rejectSandboxPolicy(policy);
  }
});

test('sandbox policy boundaries reject missing and non-string CSP values', () => {
  for (const value of [undefined, null, [], {}, 1]) {
    assert.equal(previewSandboxPolicySchema.safeParse(value).success, false);
  }

  rejectSandboxPolicy(undefined);
});

test('source-only security inspection accepts the current WXT manifest and local public pages', async () => {
  const report = await checkSecurityPolicy(repositoryRoot);

  assert.equal(report.remoteExtensionCode, false);
  assert.ok(report.staticPagesChecked > 0);
});
