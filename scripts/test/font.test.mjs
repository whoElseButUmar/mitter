import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, symlink, unlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  FONT_FILE,
  FONT_URL,
  LICENSE_URL,
  prepareFont,
  parseFontArguments,
  validateBundledFont,
  verifyBundledFont,
} from '../prepare-font.mjs';
import { fontMetadataSchema, fontSourceSchema, fontInputSchema } from '../fonts/contracts.mjs';
import { fontFixtureBytes } from '../fonts/test-fixture.mjs';

const licenseText = 'Copyright fixture\nSIL OPEN FONT LICENSE Version 1.1\n';

async function localFontFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mitter-font-'));
  const file = path.join(root, FONT_FILE);
  const licenseFile = path.join(root, 'OFL.txt');
  const fontBytes = fontFixtureBytes();
  const output = path.join(root, 'apps/extension/.output/chrome-mv3');
  const previousDigest = process.env.MITER_FONT_SHA256;

  delete process.env.MITER_FONT_SHA256;
  context.after(async () => {
    if (previousDigest === undefined) {
      delete process.env.MITER_FONT_SHA256;
    } else {
      process.env.MITER_FONT_SHA256 = previousDigest;
    }

    await rm(root, { recursive: true, force: true });
  });
  await writeFile(file, fontBytes);
  await writeFile(licenseFile, licenseText);

  return { root, file, licenseFile, fontBytes, output };
}

function rejectDownload() {
  throw new Error('Offline provisioning must not download anything.');
}

test('font name parsing checks exact identity across supported encodings and family IDs', () => {
  for (const platformId of [0, 1, 3]) {
    for (const familyNameId of [1, 16]) {
      const fontBytes = fontFixtureBytes({ platformId, familyNameId });
      const result = validateBundledFont(fontBytes);

      assert.deepEqual(result, {
        family: 'FiraCode Nerd Font Mono',
        style: 'Regular',
        sha256: createHash('sha256').update(fontBytes).digest('hex'),
        copyright: 'Copyright fixture\nCopyright second fixture',
      });
      assert.equal(fontMetadataSchema.safeParse(result).success, true);
    }
  }

  for (const options of [
    { family: 'FiraCode Nerd Font' },
    { style: 'Bold' },
    { postScriptName: 'FiraCodeNF-Reg' },
    { platformId: 2 },
  ]) {
    assert.throws(() => {
      validateBundledFont(fontFixtureBytes(options));
    }, /actual FiraCodeNerdFontMono-Regular.ttf/);
  }
});

test('font name parsing rejects truncated directories, records and strings', () => {
  const invalidFonts = [
    [Buffer.alloc(11), /Expected a TTF/],
    [Buffer.alloc(4 * 1024 * 1024 + 1), /Expected a TTF/],
  ];
  const invalidHeader = fontFixtureBytes();
  const invalidDirectory = fontFixtureBytes();
  const missingNameTable = fontFixtureBytes();
  const invalidTable = fontFixtureBytes();
  const invalidRecords = fontFixtureBytes();
  const invalidStorage = fontFixtureBytes();
  const invalidString = fontFixtureBytes();
  const invalidUnicode = fontFixtureBytes();

  invalidHeader.writeUInt32BE(0, 0);
  invalidDirectory.writeUInt16BE(257, 4);
  missingNameTable.write('none', 12, 'ascii');
  invalidTable.writeUInt32BE(invalidTable.length, 20);
  invalidRecords.writeUInt16BE(65535, 30);
  invalidStorage.writeUInt16BE(65535, 32);
  invalidString.writeUInt16BE(65535, 44);
  invalidUnicode.writeUInt16BE(1, 42);
  invalidFonts.push(
    [invalidHeader, /Expected a TTF/],
    [invalidDirectory, /Invalid TTF directory/],
    [missingNameTable, /no valid name table/],
    [invalidTable, /no valid name table/],
    [invalidRecords, /Invalid font name records/],
    [invalidStorage, /Invalid font name records/],
    [invalidString, /Invalid font name string/],
    [invalidUnicode, /Invalid UTF-16 font name/],
  );

  for (const [fontBytes, expectedError] of invalidFonts) {
    assert.throws(() => {
      validateBundledFont(fontBytes);
    }, expectedError);
  }
});

test('offline provisioning preserves exact font and license bytes on repeat builds', async (context) => {
  const fixture = await localFontFixture(context);
  const options = { ...fixture, fetcher: rejectDownload };
  const firstResult = await prepareFont(options);
  const sourceFile = path.join(fixture.output, 'fonts/FONT-SOURCE.json');
  const recordedText = await readFile(sourceFile, 'utf8');
  const recorded = fontSourceSchema.parse(JSON.parse(recordedText));

  assert.equal(recorded.file, FONT_FILE);
  assert.equal(recorded.source, FONT_URL);
  assert.equal(recorded.sha256, firstResult.sha256);
  assert.equal(
    recordedText,
    JSON.stringify(
      {
        file: FONT_FILE,
        source: FONT_URL,
        nerdFonts: 'v3.4.0',
        firaCode: '6.2',
        ...firstResult,
      },
      null,
      2,
    ) + '\n',
  );
  assert.deepEqual(await readFile(path.join(fixture.output, 'fonts', FONT_FILE)), fixture.fontBytes);
  assert.equal(await readFile(path.join(fixture.output, 'fonts/OFL.txt'), 'utf8'), licenseText);
  assert.deepEqual(await verifyBundledFont(fixture.output), firstResult);
  assert.deepEqual(await prepareFont(options), firstResult);
  assert.equal(await readFile(sourceFile, 'utf8'), recordedText);
  assert.equal((await readdir(path.join(fixture.output, 'fonts'))).length, 3);
});

test('font provenance schema rejects malformed or renamed source records', async (context) => {
  const fixture = await localFontFixture(context);

  await prepareFont({ ...fixture, fetcher: rejectDownload });

  const sourceFile = path.join(fixture.output, 'fonts/FONT-SOURCE.json');
  const recorded = fontSourceSchema.parse(JSON.parse(await readFile(sourceFile, 'utf8')));

  for (const patch of [
    { file: 'renamed.ttf' },
    { family: 'FiraCode Nerd Font' },
    { style: 'Bold' },
    { source: 'https://example.com/font.ttf' },
    { nerdFonts: 'latest' },
    { firaCode: 'latest' },
    { sha256: '0'.repeat(64) },
    { sha256: 123 },
    { copyright: null },
    { copyright: 'Unverified copyright text' },
    { extra: true },
  ]) {
    await writeFile(sourceFile, JSON.stringify({ ...recorded, ...patch }));
    await assert.rejects(verifyBundledFont(fixture.output), /identity\/hash verification failed/);
  }

  await writeFile(sourceFile, '{broken}');
  await assert.rejects(verifyBundledFont(fixture.output), (error) => {
    assert.match(error.message, /identity\/hash verification failed/);
    assert.ok(error.cause instanceof SyntaxError);

    return true;
  });
  await writeFile(sourceFile, JSON.stringify({ ...recorded, sha256: 123 }));
  await assert.rejects(verifyBundledFont(fixture.output), (error) => {
    assert.match(error.message, /identity\/hash verification failed/);
    assert.equal(error.cause.name, 'ZodError');
    assert.doesNotMatch(error.message, /invalid_type/);

    return true;
  });
  await writeFile(sourceFile, JSON.stringify(recorded));
  await writeFile(path.join(fixture.output, 'fonts/OFL.txt'), 'invalid license');
  await assert.rejects(verifyBundledFont(fixture.output), /license is missing/);
  assert.equal(typeof fontMetadataSchema.description, 'string');
  assert.equal(typeof fontSourceSchema.description, 'string');
});

test('font digest pin accepts uppercase hex and rejects mismatches before output writes', async (context) => {
  const fixture = await localFontFixture(context);
  const digest = validateBundledFont(fixture.fontBytes).sha256;

  process.env.MITER_FONT_SHA256 = '0'.repeat(64);
  await assert.rejects(prepareFont({ ...fixture, fetcher: rejectDownload }), /MITER_FONT_SHA256/);
  await assert.rejects(readFile(path.join(fixture.output, 'fonts', FONT_FILE)), { code: 'ENOENT' });
  process.env.MITER_FONT_SHA256 = digest.toUpperCase();
  assert.equal((await prepareFont({ ...fixture, fetcher: rejectDownload })).sha256, digest);
});

test('invalid offline licenses stop provisioning before output writes', async (context) => {
  const fixture = await localFontFixture(context);

  for (const invalidLicense of ['Copyright only', 'SIL OPEN FONT LICENSE Version 1.1']) {
    await writeFile(fixture.licenseFile, invalidLicense);
    await assert.rejects(
      prepareFont({ ...fixture, fetcher: rejectDownload }),
      /license is missing or invalid/,
    );
    await assert.rejects(readFile(path.join(fixture.output, 'fonts', FONT_FILE)), { code: 'ENOENT' });
  }
});

test('font downloads use pinned URLs, timeout signals and refusal of redirects', async (context) => {
  const fixture = await localFontFixture(context);
  const requestedUrls = [];

  const result = await prepareFont({
    root: fixture.root,
    async fetcher(url, options) {
      requestedUrls.push(url);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);

      if (url === FONT_URL) {
        return new Response(fixture.fontBytes);
      }

      assert.equal(url, LICENSE_URL);

      return new Response(licenseText);
    },
  });

  assert.deepEqual(requestedUrls, [FONT_URL, LICENSE_URL]);
  assert.deepEqual(await verifyBundledFont(fixture.output), result);
});

test('failed and oversized downloads never fall back to a previously bundled font', async (context) => {
  const fixture = await localFontFixture(context);

  await prepareFont({ ...fixture, fetcher: rejectDownload });

  const failures = [
    [new Response('failed', { status: 503 }), /Download failed \(503\)/],
    [new Response(null), /Empty download/],
    [new Response('small', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }), /size limit/],
    [new Response(Buffer.alloc(4 * 1024 * 1024 + 1)), /size limit/],
  ];

  for (const [response, expectedError] of failures) {
    await assert.rejects(
      prepareFont({
        root: fixture.root,
        async fetcher() {
          return response;
        },
      }),
      expectedError,
    );
    assert.deepEqual(await readFile(path.join(fixture.output, 'fonts', FONT_FILE)), fixture.fontBytes);
  }

  for (const response of [
    new Response('small', { headers: { 'content-length': '32769' } }),
    new Response(Buffer.alloc(32769)),
  ]) {
    await assert.rejects(
      prepareFont({
        root: fixture.root,
        file: fixture.file,
        async fetcher() {
          return response;
        },
      }),
      /size limit/,
    );
  }
});

test('a failed font sidecar write preserves previously installed font and license bytes', async (context) => {
  const fixture = await localFontFixture(context);
  const fontDirectory = path.join(fixture.output, 'fonts');
  const previousFont = fontFixtureBytes({ platformId: 1 });
  const previousLicense = 'Copyright previous fixture\nSIL OPEN FONT LICENSE Version 1.1\n';

  await mkdir(fontDirectory, { recursive: true });
  await writeFile(path.join(fontDirectory, FONT_FILE), previousFont);
  await writeFile(path.join(fontDirectory, 'OFL.txt'), previousLicense);
  await mkdir(path.join(fontDirectory, 'FONT-SOURCE.json'));
  await assert.rejects(prepareFont({ ...fixture, fetcher: rejectDownload }));
  assert.deepEqual(await readFile(path.join(fontDirectory, FONT_FILE)), previousFont);
  assert.equal(await readFile(path.join(fontDirectory, 'OFL.txt'), 'utf8'), previousLicense);
  assert.deepEqual((await readdir(fontDirectory)).sort(), [FONT_FILE, 'FONT-SOURCE.json', 'OFL.txt'].sort());
});

test('font provisioning refuses linked output assets without overwriting their targets', async (context) => {
  const fixture = await localFontFixture(context);
  const fontDirectory = path.join(fixture.output, 'fonts');

  await mkdir(fontDirectory, { recursive: true });

  for (const filename of [FONT_FILE, 'OFL.txt', 'FONT-SOURCE.json']) {
    const target = path.join(fixture.root, 'outside-' + filename);
    const linkedOutput = path.join(fontDirectory, filename);

    await writeFile(target, 'outside bytes must stay unchanged');
    await symlink(target, linkedOutput);
    await assert.rejects(prepareFont({ ...fixture, fetcher: rejectDownload }), /linked or non-regular/);
    assert.equal(await readFile(target, 'utf8'), 'outside bytes must stay unchanged');
    assert.deepEqual(await readdir(fontDirectory), [filename]);
    await unlink(linkedOutput);
  }
});

test('font CLI validates overrides and environment pins without discarding literal path bytes', () => {
  const environment = {
    MITER_FONT_FILE: '/environment/font.ttf',
    MITER_FONT_LICENSE: '/environment/OFL.txt',
    MITER_FONT_SHA256: 'A'.repeat(64),
  };
  const file = "./font's literal folder/Mono-Regular.ttf";
  const licenseFile = './literal license.txt';

  assert.deepEqual(parseFontArguments(['--file=' + file, '--license=' + licenseFile], environment), {
    file,
    licenseFile,
    sha256: environment.MITER_FONT_SHA256,
  });
  assert.deepEqual(parseFontArguments([], environment), {
    file: environment.MITER_FONT_FILE,
    licenseFile: environment.MITER_FONT_LICENSE,
    sha256: environment.MITER_FONT_SHA256,
  });
  assert.equal(parseFontArguments([], { MITER_FONT_SHA256: '' }).sha256, undefined);

  for (const args of [
    ['--file='],
    ['--file=   '],
    ['--license='],
    ['--file=/font\0.ttf'],
    ['--file=/first.ttf', '--file=/second.ttf'],
    ['--license=/first.txt', '--license=/second.txt'],
    ['--fiel=/font.ttf'],
    ['--file', '/font.ttf'],
    ['--unknown'],
  ]) {
    assert.throws(() => {
      parseFontArguments(args, environment);
    }, /Usage:|Invalid font input/);
  }

  for (const sha256 of ['latest', 'a'.repeat(63), 'g'.repeat(64), 123]) {
    assert.throws(() => {
      parseFontArguments([], { ...environment, MITER_FONT_SHA256: sha256 });
    }, /MITER_FONT_SHA256/);
  }
  assert.equal(fontInputSchema.safeParse({ file: '/font', fetcher: () => {} }).success, false);
});

test('invalid font configuration is rejected before local reads, downloads or output writes', async (context) => {
  const fixture = await localFontFixture(context);
  let downloads = 0;

  for (const inputs of [{ file: '' }, { licenseFile: '   ' }, { sha256: 'not-a-digest' }, { sha256: 123 }]) {
    await assert.rejects(
      prepareFont({
        root: fixture.root,
        ...inputs,
        async fetcher() {
          downloads++;

          throw new Error('Invalid configuration must not reach the downloader.');
        },
      }),
      /Invalid font input/,
    );
  }

  assert.equal(downloads, 0);
  await assert.rejects(readFile(path.join(fixture.output, 'fonts', FONT_FILE)), { code: 'ENOENT' });
});

test('font provisioning removes its partial file after a rename failure', async (context) => {
  const fixture = await localFontFixture(context);
  const fontDirectory = path.join(fixture.output, 'fonts');

  await mkdir(path.join(fontDirectory, FONT_FILE), { recursive: true });
  await assert.rejects(prepareFont({ ...fixture, fetcher: rejectDownload }));
  assert.deepEqual(await readdir(fontDirectory), [FONT_FILE]);
});
