import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { format } from 'prettier';
import { APP_COMPONENTS_JS } from '../src/task-skills/app-components.ts';

const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(APP_COMPONENTS_JS).toString('base64');
const { parseLocalDate, formatLocalDate, shiftCalendarMonth, ...controls } = await import(moduleUrl);

test('the reusable component asset is a bounded standalone JavaScript module', async () => {
  const formatted = await format(APP_COMPONENTS_JS, { parser: 'babel' });

  assert.ok(formatted.length > 0);
  assert.ok(APP_COMPONENTS_JS.length <= 20000, 'The separately loaded reference fits one observation.');
  assert.deepEqual(Object.keys(controls).sort(), [
    'confirmAction',
    'createDatePicker',
    'createDialog',
    'createTimeInput',
  ]);
  assert.doesNotMatch(APP_COMPONENTS_JS, /\b(?:fetch|eval|import)\s*\(/);
});

test('date parsing rejects malformed, impossible and out-of-range calendar values', () => {
  for (const value of [
    '',
    null,
    undefined,
    20241110,
    '2024-2-01',
    '2024-02-1',
    '2024-02-30',
    '2023-02-29',
    '1900-02-29',
    '2024-00-10',
    '2024-13-10',
    '2024-04-31',
    '2024-01-00',
    '0000-01-01',
    '10000-01-01',
    '2024-01-01T00:00:00Z',
    ' 2024-01-01',
  ]) {
    assert.equal(parseLocalDate(value), null, String(value));
  }

  for (const value of ['0001-01-01', '0099-12-31', '2000-02-29', '2024-02-29', '9999-12-31']) {
    const date = parseLocalDate(value);
    assert.ok(date instanceof Date);
    assert.equal(formatLocalDate(date), value);
  }

  assert.throws(() => formatLocalDate(new Date('invalid')), TypeError);
  assert.throws(() => formatLocalDate('2024-01-01'), TypeError);
  const unsupportedYear = new Date();
  unsupportedYear.setFullYear(10000);
  assert.throws(() => formatLocalDate(unsupportedYear), RangeError);
});

test('calendar month navigation clamps the day without mutating the selected date', () => {
  const cases = [
    ['2023-01-31', 1, '2023-02-28'],
    ['2024-01-31', 1, '2024-02-29'],
    ['2024-03-31', -1, '2024-02-29'],
    ['2024-02-29', 12, '2025-02-28'],
    ['2024-12-15', 1, '2025-01-15'],
    ['2024-01-15', -1, '2023-12-15'],
  ];

  for (const [value, amount, expected] of cases) {
    const original = parseLocalDate(value);
    assert.equal(formatLocalDate(shiftCalendarMonth(original, amount)), expected);
    assert.equal(formatLocalDate(original), value);
  }
});

test('date-only values retain their calendar day on both sides of UTC and through DST', () => {
  const source = `
    const { parseLocalDate, formatLocalDate, shiftCalendarMonth } = await import(${JSON.stringify(moduleUrl)});
    const dates = ['2024-01-01', '2024-03-10', '2024-11-03', '0099-01-01'];
    const values = dates.map((value) => {
      const date = parseLocalDate(value);
      return [formatLocalDate(date), date.getFullYear(), date.getMonth() + 1, date.getDate()];
    });
    values.push(formatLocalDate(shiftCalendarMonth(parseLocalDate('2024-01-31'), 1)));
    process.stdout.write(JSON.stringify(values));
  `;

  for (const timezone of ['Pacific/Kiritimati', 'America/Los_Angeles']) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, TZ: timezone },
      encoding: 'utf8',
    });

    assert.deepEqual(
      JSON.parse(output),
      [
        ['2024-01-01', 2024, 1, 1],
        ['2024-03-10', 2024, 3, 10],
        ['2024-11-03', 2024, 11, 3],
        ['0099-01-01', 99, 1, 1],
        '2024-02-29',
      ],
      timezone,
    );
  }
});
