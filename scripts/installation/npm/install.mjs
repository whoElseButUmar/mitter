#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: npx miter-install@latest [--chromium] [--destination=PATH]';
const supportedArchitectures = new Set(['arm64', 'x64']);

export function selectAsset(release, platform, architecture) {
  if (platform !== 'darwin' || !supportedArchitectures.has(architecture)) {
    throw new Error('Miter’s installer requires an Apple silicon or Intel Mac.');
  }

  const asset = release?.assets?.[architecture];

  if (!asset) {
    throw new Error('This Miter release has no installer for this Mac (' + architecture + ').');
  }

  const version = release.version;
  const directoryPrefix = `Miter-${version}-${architecture}-`;

  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(version) ||
    typeof asset.directory !== 'string' ||
    !asset.directory.startsWith(directoryPrefix) ||
    !/^[a-f0-9]{12}$/.test(asset.directory.slice(directoryPrefix.length)) ||
    typeof asset.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes <= 0
  ) {
    throw new Error('Miter’s release metadata is invalid.');
  }

  if (typeof asset.url !== 'string') {
    throw new Error('Miter’s download address is invalid.');
  }

  const url = new URL(asset.url);

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('/' + encodeURIComponent(asset.directory + '.zip'))
  ) {
    throw new Error('Miter’s download address is invalid.');
  }

  return asset;
}

export async function downloadVerifiedAsset(asset, filename) {
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(300_000) });

  if (!response.ok || !response.body) {
    throw new Error('Could not download Miter. The release server returned HTTP ' + response.status + '.');
  }

  if (new URL(response.url).protocol !== 'https:') {
    await response.body.cancel();
    throw new Error('Miter’s download was redirected to an insecure address.');
  }

  const hash = createHash('sha256');
  let bytes = 0;

  async function* checkedChunks() {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;

      if (bytes > asset.bytes) {
        throw new Error('Miter’s download exceeded the expected size.');
      }

      hash.update(chunk);
      yield chunk;
    }
  }

  await pipeline(checkedChunks(), createWriteStream(filename, { flags: 'wx', mode: 0o600 }));

  if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) {
    throw new Error('Miter’s download did not match the published checksum. Try again later.');
  }
}

function requestedHelp(args) {
  const seen = new Set();

  for (const arg of args) {
    let option = arg;

    if (arg.startsWith('--destination=') && arg.slice('--destination='.length).trim()) {
      option = '--destination';
    }

    if (
      !['--help', '--chromium', '--destination'].includes(option) ||
      arg === '--destination' ||
      seen.has(option)
    ) {
      throw new Error(usage);
    }

    seen.add(option);
  }

  return seen.has('--help');
}

async function install(args) {
  if (requestedHelp(args)) {
    console.log(usage);
    return;
  }

  const release = JSON.parse(await readFile(new URL('./release.json', import.meta.url), 'utf8'));
  const asset = selectAsset(release, process.platform, process.arch);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'miter-npx-'));

  try {
    console.log('Downloading Miter ' + release.version + ' for ' + process.arch + '…');
    const zip = path.join(scratch, 'miter.zip');
    await downloadVerifiedAsset(asset, zip);

    console.log('Installing verified Miter bundle…');
    execFileSync('/usr/bin/ditto', ['-x', '-k', zip, scratch], { stdio: 'inherit' });
    const bundle = path.join(scratch, asset.directory);
    const installer = path.join(bundle, 'scripts/installation/install.mjs');
    // The archive checksum covers the bundled runtime. Keep the user's working
    // directory for relative installation paths.
    execFileSync(path.join(bundle, 'runtime/node'), [installer, ...args], { stdio: 'inherit' });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await install(process.argv.slice(2));
  } catch (error) {
    console.error('Miter install stopped. ' + error.message);
    process.exitCode = 1;
  }
}
