import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestedInterfaceCopy } from './interface-copy.ts';

const line = 'Small moments. Better weekends.';

test('a record status must be explicitly requested twice to permit duplicate labels', () => {
  assert.equal(requestedInterfaceCopy(['Use “Fired” as the final status.'], 'repeated', 'Fired'), false);
  assert.equal(requestedInterfaceCopy(['Include brand copy.'], 'repeated', 'Fired'), false);
  const repeat = 'Show “Fired” twice per record.';
  assert.equal(requestedInterfaceCopy([repeat], 'repeated', 'Fired'), true);
  assert.equal(requestedInterfaceCopy([repeat], 'repeated', 'Waiting'), false);
  assert.equal(
    requestedInterfaceCopy([repeat, 'Remove duplicate status labels.'], 'repeated', 'Fired'),
    false,
  );
});

test('storing data locally only requests a notice when the user asks to communicate it', () => {
  const disclosure = 'Data is stored on this device.';
  for (const goal of ['Persist data locally.', 'Store the records in this browser.', 'Add brand copy.']) {
    assert.equal(requestedInterfaceCopy([goal], 'storage', disclosure), false, goal);
  }
  for (const goal of [
    'Include a local-only notice.',
    'Explain where the data is stored.',
    'Tell users their records stay on this device.',
  ]) {
    assert.equal(requestedInterfaceCopy([goal], 'storage', disclosure), true, goal);
  }
});

test('a style request or a quoted example does not request promotional copy', () => {
  for (const goal of [
    'Make the app feel cozy and welcoming.',
    'Avoid promotional copy, including slogans like “Small moments. Better weekends.”',
    'Never include the tagline “Small moments. Better weekends.”',
    'Do not add taglines.',
    'Only add a tagline when asked.',
    'Remove the tagline.',
    'The designer gave “add a tagline” as an example.',
  ]) {
    assert.equal(requestedInterfaceCopy([goal], 'tagline', line), false, goal);
  }
});

test('requested words and categories are scoped, and a follow-up can revoke them', () => {
  for (const goal of [
    'Add a tagline that reads “Small moments. Better weekends.”',
    'Put "Small moments. Better weekends." below the title.',
  ]) {
    assert.equal(requestedInterfaceCopy([goal], 'tagline', line), true);
    assert.equal(requestedInterfaceCopy([goal], 'tagline', 'Another slogan'), false);
  }
  const unquoted = 'Add a tagline: Build with care';
  assert.equal(requestedInterfaceCopy([unquoted], 'tagline', 'Build with care.'), true);
  assert.equal(requestedInterfaceCopy([unquoted], 'tagline', line), false);
  const conventions = 'Include a short tagline on the landing page.';
  assert.equal(requestedInterfaceCopy([conventions, 'Add PDF export.'], 'tagline', line), true);
  assert.equal(requestedInterfaceCopy([conventions], 'eyebrow', 'Your next getaway'), false);
  assert.equal(requestedInterfaceCopy([conventions, 'Remove the tagline.'], 'tagline', line), false);
  assert.equal(
    requestedInterfaceCopy([conventions, 'Never use slogans like “Another line”.'], 'tagline', line),
    false,
  );
  assert.equal(
    requestedInterfaceCopy(
      ['No taglines.', 'Add the tagline “Small moments. Better weekends.”'],
      'tagline',
      line,
    ),
    true,
  );
});

test('ordinary category requests and labeled copy briefs permit their own kind or wording', () => {
  for (const goal of ['Give it a tagline.', 'Give the app a slogan.']) {
    assert.equal(requestedInterfaceCopy([goal], 'tagline', line), true);
    assert.equal(requestedInterfaceCopy([goal], 'subtitle', line), false);
  }
  assert.equal(requestedInterfaceCopy(["I'd like a subtitle."], 'subtitle', line), true);
  assert.equal(requestedInterfaceCopy(['Do not give it a tagline.'], 'tagline', line), false);
  for (const brief of ['Tagline: Keep Sundays free.', 'Slogan: ‘Keep Sundays free.’']) {
    assert.equal(requestedInterfaceCopy([brief], 'tagline', 'Keep Sundays free.'), true);
    assert.equal(requestedInterfaceCopy([brief], 'subtitle', 'Keep Sundays free.'), false);
    assert.equal(requestedInterfaceCopy(['Give it a tagline.', brief], 'tagline', line), false);
    assert.equal(requestedInterfaceCopy([brief, 'No slogans.'], 'tagline', 'Keep Sundays free.'), false);
    assert.equal(
      requestedInterfaceCopy(['Never use the following example:\n' + brief], 'tagline', 'Keep Sundays free.'),
      false,
    );
  }
});
