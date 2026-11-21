import assert from 'node:assert/strict';
import test from 'node:test';
import { domFixture } from '../../../../packages/ui/test/dom-fixture.mjs';
import { bindTooltip } from '../../src/ui/tooltip.ts';

function fixture() {
  const dom = domFixture();
  const createElement = dom.document.createElement;
  dom.document.createElement = (tag) => {
    const element = createElement(tag);
    let open = false;
    const matches = element.matches.bind(element);
    element.matches = (selector) => {
      if (selector === ':popover-open') {
        return open;
      }
      return matches(selector);
    };
    element.showPopover = () => {
      open = true;
    };
    element.hidePopover = () => {
      open = false;
    };
    element.getBoundingClientRect = () => ({ left: 0, right: 70, top: 0, bottom: 32, width: 70, height: 32 });
    return element;
  };
  const button = dom.document.createElement('button');
  dom.root.append(button);
  let label = 'Open app';
  const tooltip = bindTooltip(button, () => label);
  const panel = dom.document.body.querySelector('[role=tooltip]');
  assert.ok(panel);
  assert.equal(panel.parentElement, button.parentElement, 'The hint remains inside the trigger’s landmark.');
  return {
    ...dom,
    button,
    panel,
    tooltip,
    setLabel: (value) => {
      label = value;
    },
  };
}

test('tooltip stays open across trigger, text, and keyboard focus without moving focus', async () => {
  const { document, button, panel, tooltip } = fixture();
  button.focus();
  await button.emit('focus');
  assert.equal(panel.hidden, false);
  assert.equal(panel.getAttribute('popover'), 'hint');
  assert.equal(panel.textContent, 'Open app');
  assert.equal(document.activeElement, button);

  await button.emit('pointerenter');
  await button.emit('pointerleave', { relatedTarget: panel });
  await panel.emit('pointerenter');
  await button.emit('blur');
  assert.equal(panel.hidden, false, 'Magnified tooltip text remains hoverable after focus leaves.');
  await panel.emit('pointerleave', { relatedTarget: document.body });
  assert.equal(panel.hidden, true);

  await button.emit('focus');
  await button.emit('pointerenter');
  await button.emit('pointerleave', { relatedTarget: document.body });
  assert.equal(panel.hidden, false, 'Keyboard focus retains the hint after the pointer leaves.');
  await button.emit('blur');
  assert.equal(panel.hidden, true);
  tooltip.dispose();
});

test('Escape dismisses without blurring and stays dismissed until interest leaves', async () => {
  const { document, button, panel, tooltip } = fixture();
  button.focus();
  await button.emit('focus');
  await button.emit('pointerenter');
  const escape = await document.emit('keydown', { key: 'Escape' });
  assert.equal(escape.prevented, true);
  assert.equal(panel.hidden, true);
  assert.equal(document.activeElement, button);
  await button.emit('pointerleave', { relatedTarget: document.body });
  await button.emit('pointerenter');
  assert.equal(panel.hidden, true, 'Retained focus cannot reopen an explicitly dismissed hint.');
  await button.emit('blur');
  await button.emit('pointerleave', { relatedTarget: document.body });
  await button.emit('pointerenter');
  assert.equal(panel.hidden, false);
  tooltip.dispose();
});

test('click dismissal does not swallow or repeat the button action', async () => {
  const { button, panel, tooltip } = fixture();
  let actions = 0;
  button.addEventListener('click', () => {
    actions += 1;
  });
  await button.emit('pointerenter');
  await button.emit('click');
  assert.equal(panel.hidden, true);
  assert.equal(actions, 1);
  tooltip.dispose();
});

test('an initially disabled button shows its tooltip on the first focus after enabling', async () => {
  const { button, panel, tooltip } = fixture();
  button.disabled = true;
  tooltip.dismiss();
  button.disabled = false;
  tooltip.refresh();
  button.focus();
  await button.emit('focus');
  assert.equal(panel.hidden, false, 'Dismissal without hover or focus must not block future interest.');
  tooltip.dispose();
});

test('selection refresh updates the open hint, while disabled and detached triggers dismiss it', async () => {
  const { button, panel, tooltip, setLabel } = fixture();
  await button.emit('focus');
  setLabel('Cozy Desk · Running');
  tooltip.refresh();
  assert.equal(panel.textContent, 'Cozy Desk · Running');
  button.disabled = true;
  tooltip.refresh();
  assert.equal(panel.hidden, true);
  await button.emit('blur');
  await button.emit('focus');
  assert.equal(panel.hidden, true);
  button.disabled = false;
  await button.emit('blur');
  await button.emit('focus');
  assert.equal(panel.hidden, false);
  button.remove();
  tooltip.refresh();
  assert.equal(panel.hidden, true);
  tooltip.dispose();
});

test('only one hint remains open and native light dismissal cleans up its listeners', async () => {
  const { document, root, window, button, panel, tooltip } = fixture();
  const other = document.createElement('button');
  root.append(other);
  const next = bindTooltip(other, () => 'Restart');
  const nextPanel = document.body.querySelectorAll('[role=tooltip]').find((entry) => entry !== panel);
  assert.ok(nextPanel);
  await button.emit('focus');
  await other.emit('pointerenter');
  assert.equal(panel.hidden, true);
  assert.equal(nextPanel.hidden, false);
  nextPanel.hidePopover();
  await nextPanel.emit('toggle');
  assert.equal(nextPanel.hidden, true);
  assert.equal(document.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
  next.dispose();
  tooltip.dispose();
  assert.equal(button.listenerCount, 0);
  assert.equal(other.listenerCount, 0);
  assert.equal(document.body.querySelectorAll('[role=tooltip]').length, 0);
});

test('tooltip position stays in the viewport and disposal releases an open tooltip', async () => {
  const { document, window, button, panel, tooltip } = fixture();
  button.getBoundingClientRect = () => ({
    left: 980,
    right: 1008,
    top: 0,
    bottom: 28,
    width: 28,
    height: 28,
  });
  await button.emit('pointerenter');
  assert.equal(panel.style.left, '922px');
  assert.equal(panel.style.top, '28px');
  assert.equal(document.activeElement, null);
  tooltip.dispose();
  tooltip.dispose();
  assert.equal(panel.hidden, true);
  assert.equal(panel.isConnected, false);
  assert.equal(button.listenerCount, 0);
  assert.equal(panel.listenerCount, 0);
  assert.equal(document.listenerCount, 0);
  assert.equal(window.listenerCount, 0);
});
