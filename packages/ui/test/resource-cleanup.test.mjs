import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { domFixture } from './dom-fixture.mjs';
import { createPopover } from '../src/popover.js';
import { enhanceSelect } from '../src/select.js';
import { mountMenu } from '../src/menu.js';
import { mountFollowupComposer } from '../src/followup-composer.js';

function selectField(document, root) {
  const select = document.createElement('select');
  const option = document.createElement('option');
  option.value = 'a';
  option.textContent = 'Alpha';
  select.append(option);
  root.append(select);
  return select;
}

test('popover disposal finishes after a close failure and cannot reopen during teardown', async () => {
  const { root, document, window, observers, frames } = domFixture();
  const trigger = document.createElement('button');
  trigger.setAttribute('aria-haspopup', 'dialog');
  const panel = document.createElement('div');
  root.append(trigger);
  const failure = new Error('Close failed');
  let popup;
  popup = createPopover(trigger, panel, {
    onClose() {
      popup.open();
      throw failure;
    },
  });
  popup.open();
  await window.emit('resize');
  assert.equal(frames.size, 1);
  assert.throws(
    () => popup.dispose(),
    (reason) => reason === failure,
  );
  assert.equal(popup.isOpen(), false);
  assert.equal(panel.isConnected, false);
  assert.equal(document.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
  assert.equal(frames.size, 0);
  assert.ok(observers.every((observer) => observer.disconnected));
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(trigger.getAttribute('aria-expanded'), null);
  assert.doesNotThrow(() => popup.dispose());
});

test('enhanced select restores native state and listeners when its popup disposer throws', () => {
  const { root, document, observers } = domFixture();
  const form = document.createElement('form');
  root.append(form);
  const select = selectField(document, form);
  const control = enhanceSelect(select);
  const disposePopup = control.popup.dispose;
  const failure = new Error('Popup disposal failed');
  control.popup.dispose = () => {
    disposePopup();
    throw failure;
  };
  assert.throws(
    () => control.dispose(),
    (reason) => reason === failure,
  );
  assert.equal(select.hidden, false);
  assert.equal(select.getAttribute('aria-hidden'), null);
  assert.equal(select.dataset.enhanced, undefined);
  assert.equal(form.querySelector('.select-control'), null);
  assert.equal(form.listenerCount, 0);
  assert.equal(select.listenerCount, 0);
  assert.equal(control.trigger.listenerCount, 0);
  assert.ok(observers.every((observer) => observer.disconnected));
  assert.doesNotThrow(() => control.dispose());
});

test('menu teardown still removes listeners after a popup disposer throws and is single-use', () => {
  const { root, document } = domFixture();
  const menu = mountMenu(root, 'Actions', [{ id: 'a', label: 'Alpha', run() {} }]);
  const disposePopup = menu.popup.dispose;
  const failure = new Error('Popup disposal failed');
  menu.popup.dispose = () => {
    disposePopup();
    throw failure;
  };
  assert.throws(
    () => menu.dispose(),
    (reason) => reason === failure,
  );
  assert.equal(menu.trigger.listenerCount, 0);
  assert.equal(document.listenerCount, 0);
  assert.equal(root.children.length, 0);
  const replacement = document.createElement('input');
  root.append(replacement);
  assert.doesNotThrow(() => menu.dispose());
  assert.equal(root.children[0], replacement);
});

for (const outcome of ['resolve', 'reject']) {
  test('late follow-up ' + outcome + ' ignores results after switching away and back', async () => {
    const { root } = domFixture();
    const pending = Promise.withResolvers();
    const options = { workerId: 'a', running: false, send: () => pending.promise };
    const composer = mountFollowupComposer(root, options);
    composer.focus('Original task draft');
    const form = root.querySelector('form');
    const sending = form.emit('submit');
    composer.update({ ...options, workerId: 'b' });
    composer.update(options);
    composer.focus('Replacement draft');
    const status = root.querySelector('.followup-status');
    const before = status.textContent;

    if (outcome === 'reject') {
      pending.reject(new Error('Old task send failed'));
    } else {
      pending.resolve();
    }

    await sending;
    assert.equal(root.querySelector('textarea').value, 'Replacement draft');
    assert.equal(status.textContent, before);
    assert.equal(status.hidden, true);
    const send = root.querySelector('.followup-footer').querySelector('.primary');
    assert.equal(send.disabled, false);
    composer.dispose();
  });
}

test('follow-up retries reuse an ID only within the same task owner', async () => {
  const { root } = domFixture();
  const requests = [];
  const options = {
    workerId: 'a',
    running: false,
    send: async (request) => {
      requests.push(request);
      throw new Error('Retry later');
    },
  };
  const composer = mountFollowupComposer(root, options);
  composer.focus('Same instruction');
  const form = root.querySelector('form');
  await form.emit('submit');
  await form.emit('submit');
  assert.equal(requests[0].id, requests[1].id);
  composer.update({ ...options, workerId: 'b' });
  await form.emit('submit');
  assert.notEqual(requests[1].id, requests[2].id);
  composer.dispose();
});

test('disposed follow-up sends ignore late failures without touching replacement DOM', async () => {
  const { root, document } = domFixture();
  const pending = Promise.withResolvers();
  const composer = mountFollowupComposer(root, {
    workerId: 'a',
    running: false,
    send: () => pending.promise,
  });
  composer.focus('Draft');
  const sending = root.querySelector('form').emit('submit');
  composer.dispose();
  const replacement = document.createElement('input');
  root.append(replacement);
  replacement.focus();
  pending.reject(new Error('Late failure'));
  await sending;
  await setImmediate();
  assert.equal(root.children[0], replacement);
  assert.equal(document.activeElement, replacement);
});
