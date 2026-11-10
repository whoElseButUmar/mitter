/** Provision exactly one upstream font into the user's locally built extension.
 * Source archives contain no font binary. No system font installation occurs.
 * Downloads are data, never executable code, and never run inside the extension.
 */
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { atomicConfig, configTransaction } from './atomic-config.mjs';
import {
  FONT_FILE,
  FONT_URL,
  LICENSE_URL,
  fontMetadataSchema,
  fontSourceSchema,
  fontInputSchema,
  fontArgumentsSchema,
} from './fonts/contracts.mjs';
import { errorMessage, isMainModule, parseJsonContract } from './helpers/runtime.mjs';

export { FONT_FILE, FONT_URL, LICENSE_URL } from './fonts/contracts.mjs';

const maximumFontBytes = 4 * 1024 * 1024;

function fontNames(buffer) {
  const font = Buffer.from(buffer);

  if (font.length < 12 || font.length > maximumFontBytes || font.readUInt32BE(0) !== 0x00010000) {
    throw new Error('Expected a TTF font no larger than 4 MB.');
  }

  const tableCount = font.readUInt16BE(4);

  if (tableCount > 256 || 12 + tableCount * 16 > font.length) {
    throw new Error('Invalid TTF directory.');
  }

  let nameTableOffset = 0;
  let nameTableLength = 0;

  for (let tableIndex = 0; tableIndex < tableCount; tableIndex++) {
    const directoryOffset = 12 + tableIndex * 16;

    if (font.toString('ascii', directoryOffset, directoryOffset + 4) === 'name') {
      nameTableOffset = font.readUInt32BE(directoryOffset + 8);
      nameTableLength = font.readUInt32BE(directoryOffset + 12);
    }
  }

  const nameTableEnd = nameTableOffset + nameTableLength;

  if (!nameTableOffset || nameTableLength < 6 || nameTableEnd > font.length) {
    throw new Error('Font has no valid name table.');
  }

  const recordCount = font.readUInt16BE(nameTableOffset + 2);
  const stringStorageOffset = nameTableOffset + font.readUInt16BE(nameTableOffset + 4);
  const namesById = new Map();

  if (nameTableOffset + 6 + recordCount * 12 > nameTableEnd || stringStorageOffset > nameTableEnd) {
    throw new Error('Invalid font name records.');
  }

  for (let recordIndex = 0; recordIndex < recordCount; recordIndex++) {
    const recordOffset = nameTableOffset + 6 + recordIndex * 12;
    const platformId = font.readUInt16BE(recordOffset);
    const nameId = font.readUInt16BE(recordOffset + 6);
    const stringLength = font.readUInt16BE(recordOffset + 8);
    const stringOffset = stringStorageOffset + font.readUInt16BE(recordOffset + 10);

    if (stringOffset < stringStorageOffset || stringOffset + stringLength > nameTableEnd) {
      throw new Error('Invalid font name string.');
    }

    let text = '';

    if (platformId === 0 || platformId === 3) {
      if (stringLength % 2 !== 0) {
        throw new Error('Invalid UTF-16 font name.');
      }

      for (let characterOffset = 0; characterOffset < stringLength; characterOffset += 2) {
        text += String.fromCharCode(font.readUInt16BE(stringOffset + characterOffset));
      }
    } else if (platformId === 1) {
      text = font.toString('latin1', stringOffset, stringOffset + stringLength);
    } else {
      continue;
    }

    const values = namesById.get(nameId) ?? [];

    values.push(text);
    namesById.set(nameId, values);
  }

  return namesById;
}

export function validateBundledFont(buffer) {
  const namesById = fontNames(buffer);
  const families = [...(namesById.get(1) ?? []), ...(namesById.get(16) ?? [])];
  const styles = namesById.get(2) ?? [];
  const postScriptNames = namesById.get(6) ?? [];

  if (
    !families.includes('FiraCode Nerd Font Mono') ||
    !styles.includes('Regular') ||
    !postScriptNames.includes('FiraCodeNFM-Reg')
  ) {
    throw new Error(
      'Use the actual FiraCodeNerdFontMono-Regular.ttf. The non-Mono FiraCodeNerdFont-Regular.ttf is a different face and must not be renamed.',
    );
  }

  return fontMetadataSchema.parse({
    family: 'FiraCode Nerd Font Mono',
    style: 'Regular',
    sha256: createHash('sha256').update(buffer).digest('hex'),
    copyright: [...new Set(namesById.get(0) ?? [])].join('\n'),
  });
}

async function download(url, maximumBytes, fetcher) {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(90000),
    redirect: 'error',
  });

  if (!response.ok) {
    throw new Error('Download failed (' + response.status + '): ' + url);
  }

  if (Number(response.headers.get('content-length') || 0) > maximumBytes) {
    throw new Error('Download exceeds its size limit.');
  }

  if (!response.body) {
    throw new Error('Empty download.');
  }

  const chunks = [];
  let downloadedBytes = 0;

  for await (const chunk of response.body) {
    downloadedBytes += chunk.length;

    if (downloadedBytes > maximumBytes) {
      throw new Error('Download exceeds its size limit.');
    }

    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export async function prepareFont({
  root = path.resolve(import.meta.dirname, '..'),
  file,
  licenseFile,
  sha256 = process.env.MITER_FONT_SHA256,
  fetcher = fetch,
} = {}) {
  const inputs = validatedFontInputs({ file, licenseFile, sha256 });
  const directory = path.join(root, 'apps/extension/.output/chrome-mv3/fonts');
  let fontBytes;

  // Preserve offline repeat builds by explicitly supplying a local file. A failed
  // download never pretends a fallback is the requested bundled default.
  if (inputs.file !== undefined) {
    fontBytes = await readFile(path.resolve(inputs.file));
  } else {
    fontBytes = await download(FONT_URL, maximumFontBytes, fetcher);
  }

  const metadata = validateBundledFont(fontBytes);
  let licenseBytes;

  if (inputs.licenseFile !== undefined) {
    licenseBytes = await readFile(path.resolve(inputs.licenseFile));
  } else {
    licenseBytes = await download(LICENSE_URL, 32768, fetcher);
  }

  const licenseText = licenseBytes.toString('utf8');

  if (!licenseText.includes('SIL OPEN FONT LICENSE Version 1.1') || !licenseText.includes('Copyright')) {
    throw new Error('The font license is missing or invalid.');
  }

  if (inputs.sha256 !== undefined && inputs.sha256.toLowerCase() !== metadata.sha256) {
    throw new Error('The font does not match MITER_FONT_SHA256.');
  }

  const source = fontSourceSchema.parse({
    file: FONT_FILE,
    source: FONT_URL,
    nerdFonts: 'v3.4.0',
    firaCode: '6.2',
    ...metadata,
  });

  await mkdir(directory, { recursive: true });

  const fontFile = path.join(directory, FONT_FILE);
  const bundledLicense = path.join(directory, 'OFL.txt');
  const sourceFile = path.join(directory, 'FONT-SOURCE.json');

  await configTransaction([fontFile, bundledLicense, sourceFile], async () => {
    await atomicConfig(fontFile, fontBytes, 0o644);
    await atomicConfig(bundledLicense, licenseBytes, 0o644);
    await atomicConfig(sourceFile, JSON.stringify(source, null, 2) + '\n', 0o644);
  });

  return metadata;
}

export async function verifyBundledFont(output) {
  const directory = path.join(output, 'fonts');
  const metadata = validateBundledFont(await readFile(path.join(directory, FONT_FILE)));
  const sourceText = await readFile(path.join(directory, 'FONT-SOURCE.json'), 'utf8');
  const recordedSource = parseJsonContract(
    fontSourceSchema,
    sourceText,
    'Bundled font identity/hash verification failed. Rebuild the font and FONT-SOURCE.json together.',
  );

  if (recordedSource.sha256 !== metadata.sha256 || recordedSource.copyright !== metadata.copyright) {
    throw new Error(
      'Bundled font identity/hash verification failed. Rebuild the font and FONT-SOURCE.json together.',
    );
  }

  const licenseText = await readFile(path.join(directory, 'OFL.txt'), 'utf8');

  if (!licenseText.includes('SIL OPEN FONT LICENSE Version 1.1')) {
    throw new Error('Bundled font license is missing.');
  }

  return metadata;
}

function validatedFontInputs({ file, licenseFile, sha256 }) {
  // An empty environment digest has historically meant no pin, not an invalid pin.
  if (sha256 === '') {
    sha256 = undefined;
  }

  const parsed = fontInputSchema.safeParse({ file, licenseFile, sha256 });

  if (!parsed.success) {
    throw new Error(
      'Invalid font input paths or MITER_FONT_SHA256. Use nonblank local paths and a 64-character hex digest pin.',
      { cause: parsed.error },
    );
  }

  return parsed.data;
}

export function parseFontArguments(args, environment = process.env) {
  const parsed = fontArgumentsSchema.safeParse(args);

  if (!parsed.success) {
    throw new Error('Usage: node scripts/prepare-font.mjs [--file=PATH] [--license=PATH]', {
      cause: parsed.error,
    });
  }

  let file = environment.MITER_FONT_FILE || undefined;
  let licenseFile = environment.MITER_FONT_LICENSE || undefined;

  for (const argument of parsed.data) {
    if (argument.startsWith('--file=')) {
      file = argument.slice('--file='.length);
    } else {
      licenseFile = argument.slice('--license='.length);
    }
  }

  return validatedFontInputs({ file, licenseFile, sha256: environment.MITER_FONT_SHA256 });
}

if (isMainModule(import.meta.url)) {
  try {
    const inputs = parseFontArguments(process.argv.slice(2));
    const result = await prepareFont(inputs);

    console.log('Prepared one local terminal font: ' + result.family + ' (' + result.sha256 + ').');
  } catch (error) {
    console.error(
      'Font provisioning failed: ' +
        errorMessage(error) +
        '\nFor an offline build, set MITER_FONT_FILE to the exact Mono-Regular TTF and MITER_FONT_LICENSE to its SIL OFL text file, then rebuild.',
    );
    process.exitCode = 1;
  }
}
