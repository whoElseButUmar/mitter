import type { Page } from 'puppeteer-core';
import { z } from 'zod';
import type { BrowserJourney } from './browser-contract.js';

// Keep screenshot masks and failure messages in sync, including autofill on textareas and selects.
const sensitiveControlSelector =
  'input:is([type="password"],[type="email"],[type="tel"],[type="file"],[type="hidden"]),' +
  ':is(input,textarea,select):is([autocomplete*="password" i],[autocomplete*="username" i],' +
  '[autocomplete*="email" i],[autocomplete*="tel" i],[autocomplete*="cc-" i],[autocomplete*="one-time-code" i])';

export async function failureEvidence(page: Page, step: BrowserJourney['steps'][number]): Promise<string> {
  const result: unknown = await page.evaluate(
    (step, sensitiveSelector) => {
      const compact = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 100);
      const sensitive = (element: Element) => element.matches(sensitiveSelector);
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        return (
          element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none'
        );
      };
      const describe = (element: Element) => {
        const fields: string[] = [element.tagName.toLowerCase() + '#' + element.id.slice(0, 80)];
        fields.push('visible=' + visible(element));
        fields.push('focused=' + (document.activeElement === element));
        const bounds = element.getBoundingClientRect();
        fields.push(
          'bounds=' + [bounds.left, bounds.top, bounds.right, bounds.bottom].map(Math.round).join(','),
        );
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
        ) {
          let value = '[redacted]';
          if (!sensitive(element)) {
            value = compact(element.value);
          }
          fields.push('value=' + JSON.stringify(value));
          fields.push('disabled=' + element.disabled);
          const invalid: string[] = [];
          for (const flag of [
            'badInput',
            'customError',
            'patternMismatch',
            'rangeOverflow',
            'rangeUnderflow',
            'stepMismatch',
            'tooLong',
            'tooShort',
            'typeMismatch',
            'valueMissing',
          ] as const) {
            if (element.validity[flag]) {
              invalid.push(flag);
            }
          }
          fields.push('validity=' + (invalid.join(',') || 'valid'));
        } else {
          fields.push('text=' + JSON.stringify(compact(element.textContent ?? '')));
        }
        return fields.join(' ');
      };
      const evidence: string[] = [];
      if ('selector' in step) {
        const matches = Array.from(document.querySelectorAll(step.selector));
        evidence.push('matches=' + matches.length);
        if (step.type === 'expect') {
          const expected: string[] = ['count=' + (step.count ?? 1)];
          if (step.visible !== undefined) {
            expected.push('visible=' + step.visible);
          }
          if (step.focused !== undefined) {
            expected.push('focused=' + step.focused);
          }
          if (step.text !== undefined) {
            let text = '[redacted]';
            if (!matches.some(sensitive)) {
              text = compact(step.text);
            }
            expected.push('text includes ' + JSON.stringify(text));
          }
          if (step.value !== undefined) {
            let value = '[redacted]';
            if (matches.length > 0 && matches.every((element) => !sensitive(element))) {
              value = compact(step.value);
            }
            expected.push('value=' + JSON.stringify(value));
          }
          evidence.push('expected ' + expected.join(' '));
        }
        evidence.push(...matches.slice(0, 2).map(describe));
      }
      const invalid = Array.from(document.querySelectorAll('input,textarea,select')).filter(
        (element) =>
          (element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement) &&
          element.willValidate &&
          visible(element) &&
          !element.validity.valid,
      );
      if (invalid.length > 0) {
        evidence.push(
          'Invalid fields (' + invalid.length + '): ' + invalid.slice(0, 4).map(describe).join('; '),
        );
      }
      return evidence.join('; ').slice(0, 1100);
    },
    step,
    sensitiveControlSelector,
  );
  return z.string().max(1100).parse(result);
}

export async function captureScreenshot(page: Page, file: string): Promise<void> {
  const mask = await page.addStyleTag({
    content:
      sensitiveControlSelector +
      '{color:transparent!important;text-shadow:none!important;caret-color:transparent!important}',
  });
  try {
    await page.screenshot({ path: file, fullPage: false });
  } finally {
    await mask.evaluate((element) => element.remove());
    await mask.dispose();
  }
}
