import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Resolve production .js imports to TypeScript sources for Node's type stripping.
const sourceImports = registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || !specifier.endsWith('.js')) {
        throw error;
      }
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
  },
});

const appearance = await import('../src/appearance.ts');
const fonts = await import('../src/fonts.ts');
const { listSystemMonospaceFonts } = await import('../src/system-fonts.ts');
const protocol = await import('../src/protocol.ts');
const { SavedPreferencesSchema } = await import('../src/appearance/preferences.ts');
sourceImports.deregister();

const colors = { foreground: '#fff', background: '#000' };

test('theme imports accept flat, colors, and theme formats', () => {
  for (const input of [colors, { colors }, { theme: colors }]) {
    assert.deepEqual(appearance.parseTheme(input, 'custom-test'), {
      id: 'custom-test',
      name: 'Imported theme',
      colors,
      custom: true,
    });
  }
  assert.equal(appearance.parseTheme({ name: '  Night  ', colors }, 'custom-test').name, 'Night');
  for (const foreground of ['#abc', '#abcd', '#ABCDEF', '#12345678']) {
    assert.equal(appearance.parseTheme({ ...colors, foreground }).colors.foreground, foreground);
  }
});

test('theme imports reject invalid shapes, executable fields, and non-hex colors', () => {
  const invalidThemes = [
    null,
    [],
    'theme',
    { colors: [] },
    { colors, script: 'alert(1)' },
    { ...colors, css: 'body {}' },
    { ...colors, foreground: 'red' },
    { ...colors, foreground: 'url(https://example.com)' },
    { background: '#000' },
    { name: '', colors },
    { name: 'a'.repeat(61), colors },
    { name: 'bad\nname', colors },
  ];
  for (const input of invalidThemes) {
    assert.throws(() => appearance.parseTheme(input));
  }
});

test('theme imports preserve identity validation, name defaults and serialized field order', () => {
  const theme = appearance.parseTheme({ name: 42, colors }, 'custom-test');
  assert.deepEqual(theme, { id: 'custom-test', name: 'Imported theme', colors, custom: true });
  assert.deepEqual(Object.keys(theme), ['id', 'name', 'colors', 'custom']);

  for (const id of ['', 42, null]) {
    assert.throws(() => appearance.parseTheme({ name: 'Night', colors }, id), {
      message: 'Invalid theme name.',
    });
  }

  assert.throws(() => appearance.parseTheme({ name: '', colors: { foreground: '#fff' } }, 'custom-test'), {
    message:
      'Choose valid hexadecimal theme colors, including foreground and background. CSS, scripts and URLs are not supported.',
  });
});

test('invalid preferences use independent defaults', () => {
  for (const input of [null, [], 'settings', {}, { version: 2 }]) {
    assert.deepEqual(appearance.parsePreferences(input), appearance.DEFAULT_TERMINAL_PREFERENCES);
  }
  const first = appearance.parsePreferences(null);
  first.customThemes.push(appearance.parseTheme(colors, 'custom-test'));
  assert.deepEqual(appearance.parsePreferences(null).customThemes, []);
  assert.deepEqual(appearance.DEFAULT_TERMINAL_PREFERENCES.customThemes, []);
});

test('preferences recover valid custom themes and ignore corrupt entries', () => {
  const customTheme = { id: 'custom-night', name: 'Night', colors };
  const preferences = appearance.parsePreferences({
    version: 1,
    themeId: customTheme.id,
    customThemes: [null, { id: 'builtin', colors }, { id: 'custom-broken' }, customTheme],
  });
  assert.deepEqual(preferences.customThemes, [{ ...customTheme, custom: true }]);
  assert.equal(appearance.resolvedTheme(preferences).id, customTheme.id);
  assert.equal(appearance.resolvedTheme({ ...preferences, themeId: 'missing' }).id, 'graphite');
  const tooMany = Array.from({ length: 21 }, (_, index) => ({
    ...customTheme,
    id: `custom-${index}`,
  }));
  assert.equal(appearance.parsePreferences({ version: 1, customThemes: tooMany }).customThemes.length, 20);
});

test('restored theme choices use the same built-in, custom and fallback resolution as display', () => {
  const customTheme = { id: 'custom-night', name: 'Night', colors };

  for (const themeId of ['graphite', 'custom-night', 'missing']) {
    const preferences = appearance.parsePreferences({ version: 1, themeId, customThemes: [customTheme] });
    assert.equal(preferences.themeId, appearance.resolvedTheme(preferences).id);
  }

  const preferences = appearance.parsePreferences({ version: 1 });
  const builtInTheme = appearance.BUILTIN_THEMES.find((theme) => theme.id === 'graphite');
  assert.equal(
    appearance.resolvedTheme({
      ...preferences,
      customThemes: [{ ...customTheme, id: 'graphite', custom: true }],
    }),
    builtInTheme,
  );
});

test('preferences keep legacy system-font opt-in and imported-font choices', () => {
  const legacy = appearance.parsePreferences({
    version: 1,
    fontFamily: 'Menlo',
  });
  assert.equal(legacy.fontFamily, 'Menlo');
  assert.equal(legacy.useSystemFonts, true);
  const disabled = appearance.parsePreferences({
    version: 1,
    fontFamily: 'Menlo',
    useSystemFonts: false,
  });
  assert.equal(disabled.fontFamily, appearance.BUNDLED_FONT);
  const imported = appearance.parsePreferences({
    version: 1,
    fontFamily: 'MiterFont_123',
    useSystemFonts: false,
  });
  assert.equal(imported.fontFamily, 'MiterFont_123');
  for (const fontFamily of ['', 'bad; font', 'a'.repeat(101), 42]) {
    assert.equal(appearance.parsePreferences({ version: 1, fontFamily }).fontFamily, appearance.BUNDLED_FONT);
  }
});

test('saved theme migration exposes checked theme records for legacy formats and null fields', () => {
  const restored = SavedPreferencesSchema.parse({
    version: 1,
    fontSize: 16,
    fontFamily: null,
    customThemes: [
      null,
      { id: 'custom-flat', ...colors },
      { id: 'custom-legacy', theme: colors },
      { id: 'custom-script', colors, script: 'run' },
    ],
  });
  assert.equal(restored.fontSize, 16);
  assert.equal(restored.fontFamily, appearance.BUNDLED_FONT);
  assert.deepEqual(
    restored.customThemes.map((theme) => theme.id),
    ['custom-flat', 'custom-legacy'],
  );

  for (const theme of restored.customThemes) {
    assert.equal(appearance.TerminalThemeSchema.safeParse(theme).success, true);
    assert.equal(theme.custom, true);
  }
});

test('preferences enforce numeric ranges and cursor values', () => {
  for (const [fontSize, lineHeight, scrollback] of [
    [10, 1, 500],
    [28, 1.8, 10000],
  ]) {
    const preferences = appearance.parsePreferences({
      version: 1,
      fontSize,
      lineHeight,
      scrollback,
      cursorStyle: 'bar',
      cursorBlink: false,
    });
    assert.equal(preferences.fontSize, fontSize);
    assert.equal(preferences.lineHeight, lineHeight);
    assert.equal(preferences.scrollback, scrollback);
    assert.equal(preferences.cursorStyle, 'bar');
    assert.equal(preferences.cursorBlink, false);
  }
  for (const value of [-1, 0, 10001, NaN, Infinity, '13']) {
    const preferences = appearance.parsePreferences({
      version: 1,
      fontSize: value,
      lineHeight: value,
      scrollback: value,
      cursorStyle: 'invalid',
    });
    assert.equal(preferences.fontSize, 13);
    assert.equal(preferences.lineHeight, 1.2);
    assert.equal(preferences.scrollback, 3000);
    assert.equal(preferences.cursorStyle, 'block');
  }
});

test('font files require a supported signature and enforce the size limit', () => {
  for (const signature of [
    [0, 1, 0, 0],
    ...['OTTO', 'wOFF', 'wOF2'].map((tag) => [...tag].map((char) => char.charCodeAt(0))),
  ]) {
    const bytes = new Uint8Array(12);
    bytes.set(signature);
    assert.doesNotThrow(() => appearance.validateFontBytes(bytes));
  }
  for (const bytes of [
    new Uint8Array(11),
    new Uint8Array(12),
    new Uint8Array(appearance.MAX_FONT_BYTES + 1),
  ]) {
    assert.throws(() => appearance.validateFontBytes(bytes));
  }
  const largest = new Uint8Array(appearance.MAX_FONT_BYTES);
  largest.set([0, 1, 0, 0]);
  assert.doesNotThrow(() => appearance.validateFontBytes(largest));
});

function fontDocument() {
  const context = {
    font: '',
    fontKerning: '',
    measureText(character) {
      const proportional = this.font.includes('Proportional') || this.font.includes('Missing');
      let width = 10;
      if (proportional && character === 'W') {
        width = 20;
      }
      return { width };
    },
  };
  return { context, createElement: () => ({ getContext: () => context }) };
}

test('monospace detection rejects unavailable and proportional fonts', () => {
  const document = fontDocument();
  assert.equal(fonts.isMonospaceFont('Menlo', document), true);
  assert.equal(document.context.font, '32px "Menlo", serif');
  assert.equal(document.context.fontKerning, 'none');
  assert.equal(fonts.isMonospaceFont('Proportional', document), false);
  assert.equal(fonts.isMonospaceFont('Missing', document), false);
  assert.equal(fonts.isMonospaceFont('bad; font', document), false);
  assert.equal(
    fonts.isMonospaceFont('Menlo', {
      createElement: () => ({ getContext: () => null }),
    }),
    false,
  );
});

test('installed fonts are filtered, deduplicated by ID, and sorted by display name', () => {
  const installed = [
    { fontId: 'Mono Z', displayName: 'Zulu' },
    { fontId: 'Mono A', displayName: 'Old name' },
    { fontId: 'Mono A', displayName: 'Alpha' },
    { fontId: appearance.BUNDLED_FONT, displayName: 'Bundled' },
    { fontId: 'Proportional', displayName: 'Proportional' },
    null,
    { fontId: 'Invalid' },
  ];
  assert.deepEqual(fonts.installedMonospaceFonts(installed, fontDocument()), [installed[2], installed[0]]);
});

test('system font discovery reports API failures and returns filtered results', async () => {
  const document = fontDocument();
  await assert.rejects(listSystemMonospaceFonts(undefined, document), /discovery is unavailable/);
  await assert.rejects(
    listSystemMonospaceFonts({ getFontList: async () => null }, document),
    /invalid font list/,
  );
  await assert.rejects(
    listSystemMonospaceFonts(
      {
        getFontList: async () => {
          throw Error('denied');
        },
      },
      document,
    ),
    /denied/,
  );
  const font = { fontId: 'Menlo', displayName: 'Menlo' };
  assert.deepEqual(await listSystemMonospaceFonts({ getFontList: async () => [font] }, document), [font]);
});

test('malformed font driver rows cannot reach canvas measurement and null lists retain diagnostics', async () => {
  let measured = 0;
  const document = {
    createElement() {
      measured++;
      assert.fail('Malformed font rows must not reach canvas measurement.');
    },
  };
  const fonts = await listSystemMonospaceFonts(
    { getFontList: async () => [null, {}, { fontId: 'bad; font', displayName: 'Unsafe' }] },
    document,
  );
  assert.deepEqual(fonts, []);
  await assert.rejects(listSystemMonospaceFonts({ getFontList: async () => null }, document), (error) => {
    assert.ok(error.cause);
    assert.match(error.message, /invalid font list/);
    return true;
  });
  assert.equal(measured, 0);
});

test('terminal requests reject invalid objects, fields, IDs, and dimensions', () => {
  for (const value of [null, [], 1, 'request']) {
    assert.throws(() => protocol.terminalObject(value));
  }
  const request = { sessionId: 'session_1' };
  assert.deepEqual(protocol.terminalObject(request), request);
  assert.doesNotThrow(() => protocol.terminalFields(request, ['sessionId']));
  assert.throws(() => protocol.terminalFields({ ...request, command: 'pwd' }, ['sessionId']));
  assert.equal(protocol.terminalId('a_1-z'), 'a_1-z');
  for (const id of ['', '../session', 'a'.repeat(101), 1]) {
    assert.throws(() => protocol.terminalId(id));
  }
  for (const value of [10, 500]) {
    assert.equal(protocol.dimension(value, 10, 500), value);
  }
  for (const value of [9, 501, 10.5, '80', NaN, Infinity]) {
    assert.throws(() => protocol.dimension(value, 10, 500));
  }
});

test('terminal object parsing preserves identity and confirmation until the explicit field check', () => {
  const request = {
    clientId: 'view_1',
    projectId: 'project_1',
    workerId: 'worker_1',
    cols: 80,
    rows: 24,
    confirm: false,
  };
  const allowed = ['clientId', 'projectId', 'workerId', 'cols', 'rows', 'confirm'];
  assert.deepEqual(protocol.terminalObject(request), request);
  assert.doesNotThrow(() => protocol.terminalFields(protocol.terminalObject(request), allowed));
  assert.equal(protocol.terminalObject({ clientId: 'view_1' }).confirm, undefined);

  for (const field of ['owner', 'origin', 'sessionId', 'approved', 'caps', 'command', 'program', 'args']) {
    const untrusted = { ...request, [field]: 'not authorized' };
    const parsed = protocol.terminalObject(untrusted);
    assert.deepEqual(parsed, untrusted);
    assert.throws(() => protocol.terminalFields(parsed, allowed), /Unexpected terminal request field/);
  }
  const input = {
    clientId: 'view_1',
    sessionId: 'shell_1',
    data: '\u0003\u001b[A\r\n',
  };
  assert.deepEqual(protocol.terminalObject(input), input);
});

test('terminal helpers retain channel identity, method names and boundary caps', () => {
  assert.equal(protocol.TERMINAL_CHANNEL, 'miter-terminal/1');
  assert.equal(protocol.TERMINAL_PORT, 'miter-terminal');
  assert.equal(protocol.MAX_INPUT, 16_384);
  assert.deepEqual(
    [...protocol.TERMINAL_METHODS],
    [
      'terminal.list',
      'terminal.create',
      'terminal.attach',
      'terminal.read',
      'terminal.write',
      'terminal.resize',
      'terminal.close',
      'terminal.release',
      'terminal.disconnect',
    ],
  );
  assert.equal(protocol.terminalId('a'.repeat(100)), 'a'.repeat(100));
  assert.equal(protocol.dimension(2, 2, 300), 2);
  assert.equal(protocol.dimension(300, 2, 300), 300);
  assert.equal(
    protocol.dimension(Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );
  for (const value of [-1, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.throws(() => protocol.dimension(value, 0, Number.MAX_SAFE_INTEGER));
  }
});

test('theme schemas require source and base colors while allowing color overrides to be omitted', () => {
  assert.equal(appearance.TerminalColorsSchema.safeParse(colors).success, true);
  assert.equal(appearance.TerminalColorsSchema.safeParse({ foreground: '#fff' }).success, false);
  assert.equal(appearance.TerminalColorsSchema.safeParse({ ...colors, script: 'run' }).success, false);

  for (const theme of appearance.BUILTIN_THEMES) {
    assert.deepEqual(appearance.TerminalThemeSchema.parse(theme), theme);
    assert.equal(theme.custom, false);
  }

  assert.equal(
    appearance.TerminalThemeSchema.safeParse({
      id: 'theme',
      name: 'Theme',
      colors,
    }).success,
    false,
  );
  assert.deepEqual(
    appearance.TerminalPreferencesSchema.parse(appearance.DEFAULT_TERMINAL_PREFERENCES),
    appearance.DEFAULT_TERMINAL_PREFERENCES,
  );
});

test('invalid saved fields fall back independently without discarding valid settings', () => {
  const preferences = appearance.parsePreferences({
    version: 1,
    fontFamily: 'Menlo',
    useSystemFonts: 'invalid',
    fontSize: 20,
    cursorStyle: 'underline',
    lineHeight: Infinity,
  });

  assert.equal(preferences.fontFamily, 'Menlo');
  assert.equal(preferences.useSystemFonts, true);
  assert.equal(preferences.fontSize, 20);
  assert.equal(preferences.cursorStyle, 'underline');
  assert.equal(preferences.lineHeight, 1.2);
  assert.equal(appearance.TerminalPreferencesSchema.safeParse(preferences).success, true);
});

test('terminal mutation receipts require complete positive acknowledgements, not null or truthy flags', () => {
  for (const [field, schema] of [
    ['written', protocol.TerminalWrittenSchema],
    ['resized', protocol.TerminalResizedSchema],
    ['closed', protocol.TerminalClosedSchema],
    ['released', protocol.TerminalReleasedSchema],
  ]) {
    const accepted = { [field]: true };
    assert.deepEqual(schema.parse(accepted), accepted);
    assert.ok(schema.description);
    assert.ok(schema.shape[field].description);
    for (const malformed of [
      null,
      undefined,
      {},
      { [field]: false },
      { [field]: 'true' },
      { ...accepted, unexpected: true },
    ]) {
      assert.equal(schema.safeParse(malformed).success, false);
    }
  }
});

test('terminal response schemas allow a project shell without a task or an exit status', () => {
  const running = {
    id: 'shell-1',
    projectId: 'project-1',
    title: 'zsh',
    cwd: '/project',
    shell: '/bin/zsh',
    pid: 1,
    cols: 80,
    rows: 24,
    createdAt: 100,
    exited: false,
    owned: true,
    occupied: false,
    paused: false,
  };

  assert.deepEqual(protocol.TerminalInfoSchema.parse(running), running);
  assert.equal(protocol.TerminalInfoSchema.safeParse({ ...running, cols: 0 }).success, false);
  assert.equal(protocol.TerminalInfoSchema.safeParse({ ...running, projectId: undefined }).success, false);
  assert.equal(
    protocol.TerminalInfoSchema.safeParse({
      ...running,
      exitCode: -1,
      exited: true,
    }).success,
    true,
  );
  assert.equal(
    protocol.TerminalReadSchema.safeParse({
      frames: [{ seq: 1, data: 'output' }],
      exited: false,
      reset: false,
      paused: false,
    }).success,
    true,
  );
  assert.equal(protocol.TerminalFrameSchema.safeParse({ seq: 1.5, data: 'output' }).success, false);
});

test('public data schemas and fields include descriptions', () => {
  const schemas = [
    appearance.TerminalColorsSchema,
    appearance.TerminalThemeSchema,
    appearance.TerminalPreferencesSchema,
    fonts.InstalledFontSchema,
    protocol.TerminalInfoSchema,
    protocol.TerminalFrameSchema,
    protocol.TerminalReadSchema,
  ];

  for (const schema of schemas) {
    assert.ok(schema.description);

    for (const [name, field] of Object.entries(schema.shape)) {
      assert.ok(field.description, 'Missing description for ' + name);
    }
  }
});
