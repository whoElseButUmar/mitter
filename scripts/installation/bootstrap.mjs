import { readFileSync } from 'node:fs';
import path from 'node:path';

export const packageVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const packageManagerPattern = /^pnpm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Bootstrap exception: setup and model installation must run without node_modules.
 * Validate the fields used to build npx argv manually; importing Zod here would
 * prevent dependency installation. Post-install contracts live in contracts.mjs.
 */
export function readBootstrapProject(root) {
  const serialized = readFileSync(path.join(root, 'package.json'), 'utf8');
  const project = JSON.parse(serialized);

  if (!isRecord(project)) {
    throw new Error('package.json must contain an object.');
  }

  return project;
}

export function readPackageManager(project) {
  if (
    !isRecord(project) ||
    typeof project.packageManager !== 'string' ||
    !packageManagerPattern.test(project.packageManager)
  ) {
    throw new Error('package.json must pin packageManager to pnpm@VERSION.');
  }

  return project.packageManager;
}

export function readModelRuntimePackages(project) {
  if (!isRecord(project) || !isRecord(project.mitter) || !isRecord(project.mitter.modelRuntimes)) {
    throw new Error('package.json must contain a mitter.modelRuntimes object.');
  }

  const entries = Object.entries(project.mitter.modelRuntimes);

  if (entries.length === 0) {
    throw new Error('package.json must pin at least one model runtime.');
  }

  const packages = [];

  for (const [name, version] of entries) {
    if (
      !packageNamePattern.test(name) ||
      typeof version !== 'string' ||
      !packageVersionPattern.test(version)
    ) {
      throw new Error('Model runtimes must use package names and exact VERSION pins.');
    }

    packages.push(`${name}@${version}`);
  }

  return packages;
}

export function parseSetupArguments(args) {
  const allowedArguments = ['--build-only', '--chromium', '--help'];
  const hasUnknownArgument = args.some((argument) => {
    return !allowedArguments.includes(argument);
  });
  const hasDuplicateArgument = new Set(args).size !== args.length;

  if (hasUnknownArgument || hasDuplicateArgument) {
    throw new Error('Usage: node scripts/setup.mjs [--build-only] [--chromium]');
  }

  return {
    buildOnly: args.includes('--build-only'),
    chromium: args.includes('--chromium'),
    help: args.includes('--help'),
  };
}

export function supportsSetupNode(version) {
  const [major, minor] = version.split('.').map(Number);

  return Number.isInteger(major) && Number.isInteger(minor) && (major > 22 || (major === 22 && minor >= 16));
}
