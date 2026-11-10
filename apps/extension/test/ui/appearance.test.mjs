import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoot } from 'solid-js';
import { createTerminalAppearance } from '../../src/ui/terminal-appearance.ts';
import {
  BUNDLED_FONT,
  DEFAULT_TERMINAL_PREFERENCES,
  MAX_FONT_BYTES,
  MAX_IMPORTED_FONT_BYTES,
  parseTheme,
} from '../../../../packages/terminal/src/appearance.ts';
import { flush } from './fixtures.mjs';

const preferencesKey = 'miter.terminal.appearance.v1';
const fontsKey = 'miter.terminal.fonts.v1';
const themeText = JSON.stringify({ name: 'Imported', colors: { foreground: '#fff', background: '#000' } });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function fontBytes(size = 12) {
  const bytes = new Uint8Array(size);
  bytes.set([0, 1, 0, 0]);
  return bytes;
}

function savedFont(family, size = 12) {
  return { family, name: family + '.ttf', data: Buffer.from(fontBytes(size)).toString('base64') };
}

function controlledFile(kind, size = 12) {
  const read = deferred();
  let reads = 0;
  const file = {
    name: 'import.' + kind,
    size,
    arrayBuffer() {
      reads++;
      return read.promise;
    },
    text() {
      reads++;
      return read.promise;
    },
  };
  return { file, read, reads: () => reads };
}

function appearanceEnvironment(context) {
  const faceLoads = [];
  const activeFaces = new Set();
  const faceMaps = new Set();
  const addedFaces = [];
  const removedFaces = [];
  const feedback = { changes: [], failures: [], messages: [] };
  const systemReads = [];
  const storage = {
    read: deferred(),
    gets: [],
    writes: [],
    hold: false,
    get(keys) {
      this.gets.push(keys);
      return this.read.promise;
    },
    set(data) {
      const completion = deferred();
      this.writes.push({ data: structuredClone(data), completion });
      if (!this.hold) {
        completion.resolve();
      }
      return completion.promise;
    },
  };

  class ControlledFontFace {
    constructor(family, source) {
      this.family = family;
      this.source = source;
      this.completion = deferred();
      faceLoads.push(this);
    }

    load() {
      return this.completion.promise.then(() => this);
    }
  }

  const originalMapSet = Map.prototype.set;
  context.mock.method(Map.prototype, 'set', function (key, value) {
    if (value instanceof ControlledFontFace) {
      faceMaps.add(this);
    }
    return originalMapSet.call(this, key, value);
  });

  const globals = {
    FontFace: ControlledFontFace,
    chrome: {
      runtime: { getURL: (name) => 'chrome-extension://test/' + name },
      storage: { local: storage },
      fontSettings: {
        getFontList() {
          const read = deferred();
          systemReads.push(read);
          return read.promise;
        },
      },
    },
    document: {
      fonts: {
        add(face) {
          activeFaces.add(face);
          addedFaces.push(face);
        },
        delete(face) {
          removedFaces.push(face);
          return activeFaces.delete(face);
        },
      },
      createElement(name) {
        assert.equal(name, 'canvas');
        return { getContext: () => ({ measureText: () => ({ width: 20 }) }) };
      },
    },
  };
  const previousGlobals = new Map();
  for (const [name, value] of Object.entries(globals)) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const owner = createRoot((dispose) => ({
    dispose,
    appearance: createTerminalAppearance(
      (preferences) => feedback.changes.push(preferences),
      (error) => feedback.failures.push(error),
      (message) => feedback.messages.push(message),
    ),
  }));
  context.after(() => {
    owner.dispose();
    for (const [name, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  async function readStartup(preferences = DEFAULT_TERMINAL_PREFERENCES, fonts = []) {
    faceLoads[0].completion.resolve();
    await flush();
    storage.read.resolve({ [preferencesKey]: preferences, [fontsKey]: fonts });
    await flush();
  }

  async function initialize(preferences = DEFAULT_TERMINAL_PREFERENCES, fonts = []) {
    await readStartup(preferences, fonts);
    for (let index = 1; index < faceLoads.length; index++) {
      faceLoads[index].completion.resolve();
      await flush();
    }
    assert.equal(owner.appearance.ready(), true);
  }

  return {
    ...owner,
    initialize,
    readStartup,
    storage,
    faceLoads,
    faceMaps,
    activeFaces,
    addedFaces,
    removedFaces,
    feedback,
    systemReads,
  };
}

for (const reject of [false, true]) {
  test('disposed theme read has no feedback or preference changes; rejected=' + reject, async (context) => {
    const environment = appearanceEnvironment(context);
    await environment.initialize();
    const input = controlledFile('json');
    const importing = environment.appearance.importTheme(input.file);
    await flush();
    environment.dispose();
    const preferences = environment.appearance.prefs();

    if (reject) {
      input.read.reject(new Error('Theme read failed.'));
    } else {
      input.read.resolve(themeText);
    }
    await importing;

    assert.equal(environment.appearance.prefs(), preferences);
    assert.deepEqual(environment.feedback, { changes: [], failures: [], messages: [] });
    assert.deepEqual(environment.storage.writes, []);
  });

  test('disposed font read creates no face or feedback; rejected=' + reject, async (context) => {
    const environment = appearanceEnvironment(context);
    await environment.initialize();
    const input = controlledFile('ttf');
    const importing = environment.appearance.importFont(input.file);
    await flush();
    environment.dispose();

    if (reject) {
      input.read.reject(new Error('Font read failed.'));
    } else {
      input.read.resolve(fontBytes().buffer);
    }
    await flush();
    for (const face of environment.faceLoads.slice(1)) {
      face.completion.resolve();
    }
    await importing;

    assert.equal(environment.faceLoads.length, 1);
    assert.equal(environment.activeFaces.size, 0);
    assert.deepEqual(environment.feedback, { changes: [], failures: [], messages: [] });
    assert.deepEqual(environment.storage.writes, []);
  });

  test(
    'disposed bundled load starts no storage read or failure feedback; rejected=' + reject,
    async (context) => {
      const environment = appearanceEnvironment(context);
      environment.dispose();
      if (reject) {
        environment.faceLoads[0].completion.reject(new Error('Font load failed.'));
      } else {
        environment.faceLoads[0].completion.resolve();
      }
      await flush();

      assert.equal(environment.activeFaces.size, 0);
      assert.deepEqual(environment.storage.gets, []);
      assert.deepEqual(environment.feedback, { changes: [], failures: [], messages: [] });
    },
  );

  test(
    'disposed system-font enumeration has no late feedback or busy update; rejected=' + reject,
    async (context) => {
      const environment = appearanceEnvironment(context);
      await environment.initialize();
      const enabling = environment.appearance.useSystemFonts(true);
      assert.equal(environment.systemReads.length, 1, 'enumeration starts in the gesture call stack');
      assert.equal(environment.appearance.fontBusy(), true);
      environment.dispose();
      const busy = environment.appearance.fontBusy();

      if (reject) {
        environment.systemReads[0].reject(new Error('Enumeration failed.'));
      } else {
        environment.systemReads[0].resolve([{ fontId: 'Test Mono', displayName: 'Test Mono' }]);
      }
      await enabling;

      assert.equal(environment.appearance.fontBusy(), busy);
      assert.deepEqual(environment.appearance.systemFonts(), []);
      assert.deepEqual(environment.feedback, { changes: [], failures: [], messages: [] });
      assert.deepEqual(environment.storage.writes, []);
    },
  );
}

test('cleanup clears owned face maps and saved base64 state, without deleting unrelated faces', async (context) => {
  const environment = appearanceEnvironment(context);
  const font = savedFont('MiterFont_a');
  await environment.initialize({ ...DEFAULT_TERMINAL_PREFERENCES, fontFamily: font.family }, [font]);
  const unrelated = { family: 'another-owner' };
  environment.activeFaces.add(unrelated);
  assert.equal(environment.appearance.fonts().length, 1);
  assert.equal(environment.faceMaps.size, 1);
  environment.dispose();

  assert.deepEqual(environment.appearance.fonts(), []);
  assert.deepEqual([...environment.activeFaces], [unrelated]);
  for (const map of environment.faceMaps) {
    assert.equal(map.size, 0);
  }
  assert.equal(environment.removedFaces.includes(unrelated), false);
});

test('disposal during saved-face restoration stops before constructing the next face', async (context) => {
  const environment = appearanceEnvironment(context);
  await environment.readStartup(DEFAULT_TERMINAL_PREFERENCES, [
    savedFont('MiterFont_a'),
    savedFont('MiterFont_b'),
  ]);
  assert.equal(environment.faceLoads.length, 2);
  environment.dispose();
  environment.faceLoads[1].completion.resolve();
  await flush();

  assert.equal(environment.faceLoads.length, 2);
  assert.equal(environment.activeFaces.size, 0);
  assert.deepEqual(environment.appearance.fonts(), []);
  assert.deepEqual(environment.feedback, { changes: [], failures: [], messages: [] });
});

for (const reject of [false, true]) {
  test(
    'disposed font storage completion cannot restore state or emit feedback; rejected=' + reject,
    async (context) => {
      const environment = appearanceEnvironment(context);
      await environment.initialize();
      environment.storage.hold = true;
      const input = controlledFile('ttf');
      const importing = environment.appearance.importFont(input.file);
      input.read.resolve(fontBytes().buffer);
      await flush();
      environment.faceLoads[1].completion.resolve();
      await flush();
      assert.equal(environment.storage.writes.length, 1);
      environment.dispose();
      const preferences = environment.appearance.prefs();

      if (reject) {
        environment.storage.writes[0].completion.reject(new Error('Storage failed.'));
      } else {
        environment.storage.writes[0].completion.resolve();
      }
      await importing;

      assert.equal(environment.appearance.prefs(), preferences);
      assert.deepEqual(environment.appearance.fonts(), []);
      assert.equal(environment.activeFaces.size, 0);
      assert.deepEqual(environment.feedback, { changes: [], failures: [], messages: [] });
      assert.equal(environment.storage.writes.length, 1, 'no preference write is started after disposal');
    },
  );
}

test('imports load validated original bytes without decoding their freshly encoded base64', async (context) => {
  const environment = appearanceEnvironment(context);
  await environment.initialize();
  const decode = context.mock.method(globalThis, 'atob');
  const input = controlledFile('ttf');
  const bytes = fontBytes();
  const importing = environment.appearance.importFont(input.file);
  input.read.resolve(bytes.buffer);
  await flush();
  assert.equal(decode.mock.callCount(), 0);
  assert.equal(environment.faceLoads[1].source.buffer, bytes.buffer);
  environment.faceLoads[1].completion.resolve();
  await importing;

  const font = environment.appearance.fonts()[0];
  assert.equal(font.data, Buffer.from(bytes).toString('base64'));
  assert.equal(environment.appearance.prefs().fontFamily, font.family);
  assert.deepEqual(environment.feedback.failures, []);
});

test('font import waits for startup capacity and never reads a third imported font', async (context) => {
  const environment = appearanceEnvironment(context);
  const input = controlledFile('ttf');
  const importing = environment.appearance.importFont(input.file);
  await flush();
  assert.equal(input.reads(), 0);
  await environment.initialize(DEFAULT_TERMINAL_PREFERENCES, [
    savedFont('MiterFont_a'),
    savedFont('MiterFont_b'),
  ]);
  await importing;

  assert.equal(input.reads(), 0);
  assert.equal(environment.appearance.fonts().length, 2);
  assert.equal(environment.faceLoads.length, 3);
  assert.match(environment.feedback.failures[0].message, /maximum 2/);
  assert.deepEqual(environment.storage.writes, []);
});

test('overlapping theme reads reserve the final slot rather than silently dropping an import', async (context) => {
  const environment = appearanceEnvironment(context);
  const customThemes = Array.from({ length: 19 }, (_, index) =>
    parseTheme(JSON.parse(themeText), 'custom-theme-' + index),
  );
  await environment.initialize({ ...DEFAULT_TERMINAL_PREFERENCES, customThemes });
  const first = controlledFile('json');
  const second = controlledFile('json');
  const firstImport = environment.appearance.importTheme(first.file);
  const secondImport = environment.appearance.importTheme(second.file);
  await flush();
  first.read.resolve(themeText);
  second.read.resolve(themeText);
  await Promise.all([firstImport, secondImport]);

  assert.equal(first.reads(), 1);
  assert.equal(second.reads(), 0);
  assert.equal(environment.appearance.prefs().customThemes.length, 20);
  assert.equal(environment.storage.writes.length, 1);
  assert.equal(environment.feedback.failures.length, 1);
  assert.match(environment.feedback.failures[0].message, /Remove a custom theme/);
});

test('import and removal serialize font snapshots and preserve the newly selected font', async (context) => {
  const environment = appearanceEnvironment(context);
  const original = savedFont('MiterFont_a');
  await environment.initialize({ ...DEFAULT_TERMINAL_PREFERENCES, fontFamily: original.family }, [original]);
  environment.storage.hold = true;
  const input = controlledFile('ttf');
  const importing = environment.appearance.importFont(input.file);
  input.read.resolve(fontBytes().buffer);
  await flush();
  environment.faceLoads[2].completion.resolve();
  await flush();
  assert.equal(environment.storage.writes.length, 1);
  const removing = environment.appearance.removeFont();
  await flush();
  assert.equal(environment.storage.writes.length, 1, 'removal must wait for the import snapshot');
  environment.storage.writes[0].completion.resolve();
  await flush();
  environment.storage.writes[1].completion.resolve();
  await importing;
  await flush();
  const imported = environment.appearance.fonts().find((font) => font.family !== original.family);
  assert.ok(imported);
  assert.deepEqual(environment.storage.writes[2].data[fontsKey], [imported]);
  environment.storage.writes[2].completion.resolve();
  await removing;

  assert.deepEqual(environment.appearance.fonts(), [imported]);
  assert.equal(environment.appearance.prefs().fontFamily, imported.family);
  assert.equal(
    [...environment.activeFaces].some((face) => face.family === original.family),
    false,
  );
  assert.equal(
    [...environment.activeFaces].some((face) => face.family === imported.family),
    true,
  );
});

for (const stored of [null, []]) {
  test(
    'malformed terminal storage envelopes cannot authorize preference writes or imports: ' +
      JSON.stringify(stored),
    async (context) => {
      const environment = appearanceEnvironment(context);
      environment.faceLoads[0].completion.resolve();
      await flush();
      environment.storage.read.resolve(stored);
      await flush();
      assert.equal(environment.appearance.ready(), false);
      assert.equal(environment.feedback.failures.length, 1);
      assert.ok(environment.feedback.failures[0].cause);
      await assert.rejects(
        environment.appearance.apply({ ...DEFAULT_TERMINAL_PREFERENCES, fontSize: 20 }),
        /unavailable/,
      );
      const input = controlledFile('json');
      await environment.appearance.importTheme(input.file);
      assert.equal(input.reads(), 0);
      assert.deepEqual(environment.storage.writes, []);
      assert.equal(environment.faceLoads.length, 1);
    },
  );
}

test('preference writes recover after failure and disposal skips queued writes', async (context) => {
  const environment = appearanceEnvironment(context);
  await environment.initialize();
  environment.storage.hold = true;
  const first = environment.appearance.apply({ ...environment.appearance.prefs(), fontSize: 14 });
  const rejected = assert.rejects(first, /First write failed/);
  const second = environment.appearance.apply({ ...environment.appearance.prefs(), fontSize: 15 });
  await flush();
  assert.equal(environment.storage.writes.length, 1);
  environment.storage.writes[0].completion.reject(new Error('First write failed.'));
  await rejected;
  await flush();
  assert.equal(environment.storage.writes.length, 2);
  assert.equal(environment.storage.writes[1].data[preferencesKey].fontSize, 15);
  const third = environment.appearance.apply({ ...environment.appearance.prefs(), fontSize: 16 });
  environment.dispose();
  environment.storage.writes[1].completion.resolve();
  await flush();
  for (const write of environment.storage.writes.slice(2)) {
    write.completion.resolve();
  }
  await Promise.all([second, third]);

  assert.equal(environment.storage.writes.length, 2);
  assert.deepEqual(environment.feedback.failures, []);
});

for (const size of [MAX_FONT_BYTES + 1, MAX_IMPORTED_FONT_BYTES]) {
  test('font size limits reject before reading oversized input: ' + size, async (context) => {
    const environment = appearanceEnvironment(context);
    await environment.initialize();
    const input = controlledFile('ttf', size);
    await environment.appearance.importFont(input.file);
    assert.equal(input.reads(), 0);
    assert.equal(environment.faceLoads.length, 1);
    assert.equal(environment.feedback.failures.length, 1);
    assert.match(environment.feedback.failures[0].message, /4 MB/);
  });
}

test('total font byte cap includes restored fonts before starting another read', async (context) => {
  const environment = appearanceEnvironment(context);
  await environment.initialize(DEFAULT_TERMINAL_PREFERENCES, [savedFont('MiterFont_a', MAX_FONT_BYTES)]);
  const input = controlledFile('ttf', 3 * 1024 * 1024);
  await environment.appearance.importFont(input.file);

  assert.equal(input.reads(), 0);
  assert.equal(environment.appearance.fonts().length, 1);
  assert.match(environment.feedback.failures[0].message, /6 MB/);
  assert.deepEqual(environment.storage.writes, []);
});

test('actual font bytes remain validated before face creation or persistence', async (context) => {
  const environment = appearanceEnvironment(context);
  await environment.initialize();
  const input = controlledFile('ttf');
  const importing = environment.appearance.importFont(input.file);
  input.read.resolve(new Uint8Array(12).buffer);
  await importing;

  assert.equal(environment.faceLoads.length, 1);
  assert.match(environment.feedback.failures[0].message, /Supported font files/);
  assert.deepEqual(environment.storage.writes, []);
});

for (const operation of ['theme', 'font', 'system', 'remove']) {
  for (const reject of [false, true]) {
    test(
      'disposed ' + operation + ' preference completion has no UI side effects; rejected=' + reject,
      async (context) => {
        const environment = appearanceEnvironment(context);
        const original = savedFont('MiterFont_a');
        if (operation === 'remove') {
          await environment.initialize({ ...DEFAULT_TERMINAL_PREFERENCES, fontFamily: original.family }, [
            original,
          ]);
        } else {
          await environment.initialize();
        }
        environment.storage.hold = true;
        let pending;
        let preferenceWrite = 0;

        if (operation === 'theme') {
          const input = controlledFile('json');
          pending = environment.appearance.importTheme(input.file);
          input.read.resolve(themeText);
        } else if (operation === 'font') {
          const input = controlledFile('ttf');
          pending = environment.appearance.importFont(input.file);
          input.read.resolve(fontBytes().buffer);
          await flush();
          environment.faceLoads[1].completion.resolve();
          await flush();
          environment.storage.writes[0].completion.resolve();
          preferenceWrite = 1;
        } else if (operation === 'system') {
          pending = environment.appearance.useSystemFonts(true);
          environment.systemReads[0].resolve([{ fontId: 'Test Mono', displayName: 'Test Mono' }]);
        } else {
          pending = environment.appearance.removeFont();
        }
        await flush();
        assert.equal(environment.storage.writes.length, preferenceWrite + 1);
        assert.ok(environment.storage.writes[preferenceWrite].data[preferencesKey]);
        environment.dispose();
        const preferences = environment.appearance.prefs();
        const feedback = structuredClone(environment.feedback);

        if (reject) {
          environment.storage.writes[preferenceWrite].completion.reject(
            new Error('Preference write failed.'),
          );
        } else {
          environment.storage.writes[preferenceWrite].completion.resolve();
        }
        await pending;

        assert.equal(environment.appearance.prefs(), preferences);
        assert.deepEqual(environment.appearance.fonts(), []);
        assert.deepEqual(environment.appearance.systemFonts(), []);
        assert.deepEqual(environment.feedback, feedback);
        assert.equal(environment.activeFaces.size, 0);
        assert.equal(environment.storage.writes.length, preferenceWrite + 1);
      },
    );
  }
}

for (const reject of [false, true]) {
  test(
    'disposed removal storage completion cannot restore font state; rejected=' + reject,
    async (context) => {
      const environment = appearanceEnvironment(context);
      const font = savedFont('MiterFont_a');
      await environment.initialize({ ...DEFAULT_TERMINAL_PREFERENCES, fontFamily: font.family }, [font]);
      environment.storage.hold = true;
      const removing = environment.appearance.removeFont();
      await flush();
      environment.storage.writes[0].completion.resolve();
      await flush();
      assert.deepEqual(environment.storage.writes[1].data[fontsKey], []);
      environment.dispose();
      const feedback = structuredClone(environment.feedback);
      const removals = environment.removedFaces.length;

      if (reject) {
        environment.storage.writes[1].completion.reject(new Error('Removal write failed.'));
      } else {
        environment.storage.writes[1].completion.resolve();
      }
      await removing;

      assert.deepEqual(environment.appearance.fonts(), []);
      assert.equal(environment.activeFaces.size, 0);
      assert.equal(environment.removedFaces.length, removals);
      assert.deepEqual(environment.feedback, feedback);
    },
  );

  test(
    'disposed imported-face load adds no face or failure feedback; rejected=' + reject,
    async (context) => {
      const environment = appearanceEnvironment(context);
      await environment.initialize();
      const input = controlledFile('ttf');
      const importing = environment.appearance.importFont(input.file);
      input.read.resolve(fontBytes().buffer);
      await flush();
      assert.equal(environment.faceLoads.length, 2);
      environment.dispose();

      if (reject) {
        environment.faceLoads[1].completion.reject(new Error('Imported face failed.'));
      } else {
        environment.faceLoads[1].completion.resolve();
      }
      await importing;

      assert.equal(environment.addedFaces.length, 1);
      assert.equal(environment.activeFaces.size, 0);
      assert.deepEqual(environment.storage.writes, []);
      assert.deepEqual(environment.feedback, { changes: [], failures: [], messages: [] });
    },
  );
}

test('failed theme reads release their reservation so the final slot can be retried', async (context) => {
  const environment = appearanceEnvironment(context);
  const customThemes = Array.from({ length: 19 }, (_, index) =>
    parseTheme(JSON.parse(themeText), 'custom-theme-' + index),
  );
  await environment.initialize({ ...DEFAULT_TERMINAL_PREFERENCES, customThemes });
  const failed = controlledFile('json');
  const first = environment.appearance.importTheme(failed.file);
  await flush();
  failed.read.reject(new Error('Theme read failed.'));
  await first;
  const retry = controlledFile('json');
  const second = environment.appearance.importTheme(retry.file);
  retry.read.resolve(themeText);
  await second;

  assert.equal(retry.reads(), 1);
  assert.equal(environment.appearance.prefs().customThemes.length, 20);
  assert.equal(environment.feedback.failures.length, 1);
  assert.equal(environment.storage.writes.length, 1);
});

test('failed font persistence releases the install lock and rolls back only its own face', async (context) => {
  const environment = appearanceEnvironment(context);
  await environment.initialize();
  environment.storage.hold = true;
  const failed = controlledFile('ttf');
  const first = environment.appearance.importFont(failed.file);
  failed.read.resolve(fontBytes().buffer);
  await flush();
  environment.faceLoads[1].completion.resolve();
  await flush();
  environment.storage.writes[0].completion.reject(new Error('Font write failed.'));
  await first;
  assert.deepEqual(environment.appearance.fonts(), []);
  assert.deepEqual(
    [...environment.activeFaces].map((face) => face.family),
    [BUNDLED_FONT],
  );
  environment.storage.hold = false;
  const retry = controlledFile('ttf');
  const second = environment.appearance.importFont(retry.file);
  retry.read.resolve(fontBytes().buffer);
  await flush();
  environment.faceLoads[2].completion.resolve();
  await second;

  assert.equal(retry.reads(), 1);
  assert.equal(environment.appearance.fonts().length, 1);
  assert.equal(environment.feedback.failures.length, 1);
  assert.match(environment.feedback.failures[0].message, /Font write failed/);
});

test('restored duplicate font families never leave an untracked face after cleanup', async (context) => {
  const environment = appearanceEnvironment(context);
  const font = savedFont('MiterFont_a');
  await environment.initialize(DEFAULT_TERMINAL_PREFERENCES, [font, font]);
  assert.equal(environment.faceLoads.length, 2);
  assert.deepEqual(environment.appearance.fonts(), [font]);
  environment.dispose();
  assert.equal(environment.activeFaces.size, 0);
});

test('the exact 6 MB byte limit accepts padded base64 without counting padding as font data', async (context) => {
  const environment = appearanceEnvironment(context);
  await environment.initialize(DEFAULT_TERMINAL_PREFERENCES, [savedFont('MiterFont_a', MAX_FONT_BYTES)]);
  const input = controlledFile('ttf', MAX_IMPORTED_FONT_BYTES - MAX_FONT_BYTES);
  const importing = environment.appearance.importFont(input.file);
  input.read.resolve(fontBytes(input.file.size).buffer);
  await flush();
  assert.equal(environment.faceLoads.length, 3);
  environment.faceLoads[2].completion.resolve();
  await importing;

  assert.equal(environment.appearance.fonts().length, 2);
  assert.deepEqual(environment.feedback.failures, []);
});

test('actual returned bytes cannot bypass the total cap with a smaller declared size', async (context) => {
  const environment = appearanceEnvironment(context);
  await environment.initialize(DEFAULT_TERMINAL_PREFERENCES, [savedFont('MiterFont_a', MAX_FONT_BYTES)]);
  const input = controlledFile('ttf');
  const importing = environment.appearance.importFont(input.file);
  input.read.resolve(fontBytes(3 * 1024 * 1024).buffer);
  await importing;

  assert.equal(environment.faceLoads.length, 2);
  assert.equal(environment.appearance.fonts().length, 1);
  assert.match(environment.feedback.failures[0].message, /6 MB/);
  assert.deepEqual(environment.storage.writes, []);
});

test('disposal closes every appearance entrypoint without new reads, writes, or callbacks', async (context) => {
  const environment = appearanceEnvironment(context);
  await environment.initialize();
  environment.dispose();
  const theme = controlledFile('json');
  const font = controlledFile('ttf');
  await Promise.all([
    environment.appearance.importTheme(theme.file),
    environment.appearance.importFont(font.file),
    environment.appearance.removeFont(),
    environment.appearance.useSystemFonts(true),
    environment.appearance.apply({ ...DEFAULT_TERMINAL_PREFERENCES, fontSize: 14 }),
  ]);

  assert.equal(theme.reads(), 0);
  assert.equal(font.reads(), 0);
  assert.equal(environment.faceLoads.length, 1);
  assert.deepEqual(environment.systemReads, []);
  assert.deepEqual(environment.storage.writes, []);
  assert.deepEqual(environment.feedback, { changes: [], failures: [], messages: [] });
});

test('failed startup storage cannot overwrite unknown saved settings or import capacity', async (context) => {
  const environment = appearanceEnvironment(context);
  const preferences = environment.appearance.prefs();
  const theme = controlledFile('json');
  const font = controlledFile('ttf');
  const importingTheme = environment.appearance.importTheme(theme.file);
  const importingFont = environment.appearance.importFont(font.file);

  await assert.rejects(
    environment.appearance.apply({ ...preferences, fontSize: 19 }),
    /Saved terminal settings are unavailable\. Reload/,
  );
  assert.equal(environment.appearance.prefs(), preferences);
  assert.deepEqual(environment.storage.writes, []);

  environment.faceLoads[0].completion.resolve();
  await flush();
  assert.equal(environment.storage.gets.length, 1);
  assert.equal(theme.reads(), 0);
  assert.equal(font.reads(), 0);

  const storageError = new Error('Storage read failed.');
  environment.storage.read.reject(storageError);
  await Promise.all([importingTheme, importingFont]);

  assert.equal(environment.appearance.ready(), false);
  assert.equal(environment.appearance.prefs(), preferences);
  assert.equal(theme.reads(), 0);
  assert.equal(font.reads(), 0);
  assert.equal(environment.faceLoads.length, 1);
  assert.deepEqual(environment.storage.writes, []);
  assert.deepEqual(environment.feedback.changes, []);
  assert.deepEqual(environment.feedback.messages, []);
  assert.equal(environment.feedback.failures.length, 3);
  assert.match(
    environment.feedback.failures[0].message,
    /Saved terminal appearance could not be read\. Reload/,
  );
  assert.equal(environment.feedback.failures[0].cause, storageError);
  for (const failure of environment.feedback.failures.slice(1)) {
    assert.match(failure.message, /Saved terminal settings are unavailable\. Reload/);
  }

  await assert.rejects(
    environment.appearance.apply({ ...preferences, fontSize: 20 }),
    /Saved terminal settings are unavailable\. Reload/,
  );
  assert.equal(environment.appearance.prefs(), preferences);
  assert.deepEqual(environment.storage.writes, []);
});

test('startup restoration cannot overwrite a newer preference edit made while a saved font loads', async (context) => {
  const environment = appearanceEnvironment(context);
  await environment.readStartup({ ...DEFAULT_TERMINAL_PREFERENCES, fontSize: 17 }, [
    savedFont('MiterFont_a'),
  ]);
  await environment.appearance.apply({ ...environment.appearance.prefs(), fontSize: 19 });
  environment.faceLoads[1].completion.resolve();
  await flush();

  assert.equal(environment.appearance.ready(), true);
  assert.equal(environment.appearance.prefs().fontSize, 19);
  assert.equal(environment.storage.writes[0].data[preferencesKey].fontSize, 19);
  assert.equal(environment.feedback.changes.length, 1);
});

test('one failed font-face removal cannot strand other faces or saved base64 state', async (context) => {
  const environment = appearanceEnvironment(context);
  await environment.initialize(DEFAULT_TERMINAL_PREFERENCES, [savedFont('MiterFont_a')]);
  const warnings = [];
  context.mock.method(console, 'warn', (...args) => warnings.push(args));
  const remove = document.fonts.delete;
  let failed = false;
  context.mock.method(document.fonts, 'delete', (face) => {
    if (face.family === BUNDLED_FONT && !failed) {
      failed = true;
      throw new Error('Font-face removal failed.');
    }
    return remove(face);
  });
  assert.doesNotThrow(() => environment.dispose());
  assert.deepEqual(environment.appearance.fonts(), []);
  assert.equal(
    [...environment.activeFaces].some((face) => face.family === 'MiterFont_a'),
    false,
  );
  for (const map of environment.faceMaps) {
    assert.equal(map.size, 0);
  }
  assert.equal(warnings.length, 1);
});
