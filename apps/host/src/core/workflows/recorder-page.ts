import { randomUUID } from 'node:crypto';
import type { Page } from 'puppeteer-core';
import { browserStepSchema, type BrowserJourney } from '../quality/browser-contract.js';

type Step = BrowserJourney['steps'][number];

// Chrome executes this function in a named isolated world. The app cannot call
// its binding or change its listeners by replacing page globals.
function watchDocument(origin: string) {
  if (window !== window.top || location.origin !== origin) {
    return;
  }
  const emit = Reflect.get(globalThis, 'miterRecordStep');
  if (typeof emit !== 'function') {
    return;
  }
  let picking = false;
  Reflect.set(globalThis, 'miterChooseExpectedElement', () => {
    if (picking) {
      return false;
    }
    picking = true;
    return true;
  });

  function field(element: Element) {
    return (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    );
  }

  function privateControl(element: Element) {
    if (!field(element)) {
      return false;
    }
    return (
      element.matches('input[type=password],input[type=file],input[type=hidden]') ||
      /password|one-time-code|cc-|credit.?card|secret|token|cvc|cvv|pin.?code/i.test(
        [element.autocomplete, element.name, element.id, element.getAttribute('aria-label')].join(' '),
      )
    );
  }

  function selectorFor(element: Element) {
    const tag = element.localName;
    const candidates = [];
    if (element.id) {
      candidates.push('#' + CSS.escape(element.id));
    }
    for (const attr of ['data-testid', 'name', 'aria-label']) {
      const value = element.getAttribute(attr);
      if (value) {
        candidates.push(tag + '[' + attr + '=' + CSS.escape(value) + ']');
      }
    }
    for (const candidate of candidates) {
      if (candidate.length <= 300 && document.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
    }
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement) {
      const parent: Element | null = current.parentElement;
      if (!parent) {
        return;
      }
      const siblings = Array.from(parent.children).filter((child) => child.localName === current?.localName);
      let part = CSS.escape(current.localName);
      if (siblings.length > 1) {
        part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (candidate.length > 300) {
        return;
      }
      if (document.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
      current = parent;
    }
    return;
  }

  function selectExpectation(event: Event, element: Element) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const selector = selectorFor(element);
    if (!selector || privateControl(element)) {
      return;
    }
    const step: Extract<Step, { type: 'expect' }> = { type: 'expect', selector, visible: true };
    if (element instanceof HTMLInputElement && element.matches('[type=checkbox],[type=radio]')) {
      // Canceled native activation restores the previous checked state after dispatch.
      picking = false;
      setTimeout(() => {
        step.checked = element.checked;
        emit(JSON.stringify(step));
      }, 0);
      return;
    } else if (field(element)) {
      step.value = element.value.slice(0, 2000);
    } else {
      const text = element.textContent?.trim().slice(0, 200);
      if (text) {
        step.text = text;
      }
    }
    picking = false;
    emit(JSON.stringify(step));
  }

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    window.addEventListener(
      type,
      (event) => {
        if (event.isTrusted && picking) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
  }
  window.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted || !(event.target instanceof Element)) {
        return;
      }
      if (picking) {
        selectExpectation(event, event.target);
        return;
      }
      if (event.detail === 0) {
        return;
      }
      const element =
        event.target.closest(
          'button,a[href],label,input,textarea,[role=button],[role=tab],[role=option],[role=menuitem]',
        ) ?? event.target;
      const selector = selectorFor(element);
      if (selector && !privateControl(element) && !element.matches('select,option')) {
        emit(JSON.stringify({ type: 'click', selector }));
      }
    },
    true,
  );

  window.addEventListener(
    'input',
    (event) => {
      const element = event.target;
      if (
        !event.isTrusted ||
        picking ||
        !(element instanceof Element) ||
        !field(element) ||
        privateControl(element) ||
        element.matches('input[type=checkbox],input[type=radio],select[multiple]')
      ) {
        return;
      }
      const selector = selectorFor(element);
      if (selector) {
        emit(JSON.stringify({ type: 'fill', selector, value: element.value }));
      }
    },
    true,
  );

  window.addEventListener(
    'keydown',
    (event) => {
      if (
        !event.isTrusted ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        !(event.target instanceof Element) ||
        privateControl(event.target)
      ) {
        return;
      }
      if (picking && event.key === 'Enter') {
        selectExpectation(event, event.target);
        return;
      }
      if (picking || (event.target instanceof HTMLSelectElement && event.key !== 'Tab')) {
        return;
      }
      let key = event.key;
      if (event.shiftKey && key === 'Tab') {
        key = 'Shift+Tab';
      }
      if (key === ' ' && !field(event.target)) {
        key = 'Space';
      }
      if (
        [
          'Enter',
          'Escape',
          'Tab',
          'Shift+Tab',
          'Space',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'Home',
          'End',
        ].includes(key)
      ) {
        emit(JSON.stringify({ type: 'press', key }));
      }
    },
    true,
  );
}

export async function installRecorder(page: Page, origin: string, onStep: (step: Step) => void) {
  const session = await page.createCDPSession();
  const world = 'miter-workflow-' + randomUUID();
  const { frameTree } = await session.send('Page.getFrameTree');
  let contextId: number | undefined;
  session.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.name === world && context.auxData?.frameId === frameTree.frame.id) {
      contextId = context.id;
    }
  });
  session.on('Runtime.executionContextDestroyed', (event) => {
    if (event.executionContextId === contextId) {
      contextId = undefined;
    }
  });
  session.on('Runtime.executionContextsCleared', () => {
    contextId = undefined;
  });
  session.on('Runtime.bindingCalled', (event) => {
    if (
      event.executionContextId !== contextId ||
      event.name !== 'miterRecordStep' ||
      event.payload.length > 15000
    ) {
      return;
    }
    const parsed = browserStepSchema.safeParse(JSON.parse(event.payload));
    if (parsed.success) {
      onStep(parsed.data);
    }
  });
  try {
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Runtime.addBinding', { name: 'miterRecordStep', executionContextName: world });
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
      worldName: world,
      source: '(' + watchDocument.toString() + ')(' + JSON.stringify(origin) + ')',
      runImmediately: true,
    });
    // runImmediately only covers worlds already created in the current document.
    const { executionContextId } = await session.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: world,
    });
    await session.send('Runtime.evaluate', {
      contextId: executionContextId,
      expression:
        'if (!globalThis.miterChooseExpectedElement) (' +
        watchDocument.toString() +
        ')(' +
        JSON.stringify(origin) +
        ')',
    });
    return {
      async arm() {
        await page.bringToFront();
        if (contextId !== undefined) {
          const { result } = await session.send('Runtime.evaluate', {
            contextId,
            expression: 'globalThis.miterChooseExpectedElement?.()',
          });
          if (result.value === true) {
            return;
          }
          if (result.value === false) {
            throw new Error('Choose the expected result in the recording window.');
          }
        }
        throw new Error('Open the app in the recording window before choosing an expected result.');
      },
      async dispose() {
        await session.detach().catch(() => undefined);
      },
    };
  } catch (error) {
    await session.detach().catch(() => undefined);
    throw error;
  }
}
