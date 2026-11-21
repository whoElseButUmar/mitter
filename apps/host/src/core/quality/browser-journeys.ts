import path from 'node:path';
import { observeJourneyPages } from './browser-journey-pages.js';
import { DomainRejections } from './domain-rejections.js';
import { inspectInterfaceCopy } from './interface-copy.js';
import { checkNativeValidation } from './browser-validation.js';
import { captureScreenshot, failureEvidence } from './browser-evidence.js';
import axe from 'axe-core';
import type { Browser, HTTPRequest, Page } from 'puppeteer-core';
import { z } from 'zod';
import type { BackendActivity } from './backend-journey.js';
import {
  backendJourneyEvidenceSchema,
  browserJourneysSchema,
  type BrowserJourney,
} from './browser-contract.js';

const findingLimit = 40;
const operationTimeout = 5000;
const viewports = [
  { name: 'desktop', width: 1365, height: 900, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
  { name: 'reflow', width: 320, height: 800, mobile: true },
] as const;

const findingsSchema = z
  .array(z.string().max(1500))
  .max(100)
  .describe('Bounded findings returned by fixed browser checks.');
const axeFindingsSchema = z
  .array(
    z.strictObject({
      id: z.string().max(100).describe('The axe rule that failed.'),
      help: z.string().max(500).describe('The accessibility rule explanation.'),
      targets: z.array(z.string().max(500)).max(5).describe('Selectors for the first affected elements.'),
    }),
  )
  .max(100)
  .describe('Accessibility violations from the fixed axe audit, without page HTML.');

export const browserJourneyResultSchema = z
  .strictObject({
    ok: z.boolean().describe('All declared journeys and automatic rendered checks passed.'),
    findings: findingsSchema.describe('Repairable failures, capped at 40 distinct findings.'),
    backend: backendJourneyEvidenceSchema.optional(),
    screenshots: z.array(z.string()).max(15).describe('Host-owned viewport screenshots of checked states.'),
    journeys: z
      .number()
      .int()
      .nonnegative()
      .describe('Declared journeys completed across both device sizes.'),
  })
  .describe('Observed browser checks; these do not certify WCAG conformance or visual taste.');

export type BrowserJourneyResult = z.infer<typeof browserJourneyResultSchema>;
type JourneyRequest = {
  browser: Browser;
  url: string;
  frameworkRoutes?: boolean;
  copyInstructions?: readonly string[];
  journeys: BrowserJourney[];
  reportDirectory: string;
  backend?: { activity: BackendActivity; reset: () => Promise<void> };
  signal: AbortSignal;
};

async function renderFindings(page: Page): Promise<string[]> {
  const result: unknown = await page.evaluate(() => {
    const findings: string[] = [];
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const label = (element: Element) => {
      if (element.id) {
        return '#' + element.id.slice(0, 80);
      }
      return (
        element.tagName.toLowerCase().slice(0, 40) +
        Array.from(element.classList)
          .slice(0, 2)
          .map((value) => '.' + value.slice(0, 40))
          .join('') +
        ' ' +
        (element.getAttribute('aria-label') ?? element.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80)
      );
    };
    if (!document.body || !document.body.innerText.trim()) {
      findings.push('The page has no visible text. Render the actual app and an accessible heading.');
    }
    if (!document.title.trim()) {
      findings.push('Set a descriptive document title.');
    }
    const viewportWidth = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > viewportWidth + 2) {
      const culprits: string[] = [];
      for (const element of Array.from(document.querySelectorAll('body *')).slice(0, 2000)) {
        const bounds = element.getBoundingClientRect();
        if (!visible(element) || (bounds.left >= -2 && bounds.right <= viewportWidth + 2)) {
          continue;
        }
        const position = getComputedStyle(element).position;
        let offsetParent: Element | null = null;
        if (element instanceof HTMLElement) {
          offsetParent = element.offsetParent;
        }
        let contained = false;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          // Absolute descendants can escape a static scrollport when their
          // containing block is outside it. Keep those in the evidence.
          if (position === 'fixed' || (position === 'absolute' && !parent.contains(offsetParent))) {
            continue;
          }
          const frame = parent.getBoundingClientRect();
          if (
            /^(auto|scroll|hidden|clip)$/.test(getComputedStyle(parent).overflowX) &&
            frame.left >= -2 &&
            frame.right <= viewportWidth + 2
          ) {
            contained = true;
            break;
          }
        }
        if (!contained) {
          let description =
            label(element) +
            ' [left=' +
            Math.round(bounds.left) +
            ', right=' +
            Math.round(bounds.right) +
            ', position=' +
            position;
          if (offsetParent) {
            description += ', offsetParent=' + offsetParent.tagName.toLowerCase().slice(0, 40);
            if (offsetParent.id) {
              description += '#' + offsetParent.id.slice(0, 80);
            }
          }
          culprits.push(description + ']');
        }
        if (culprits.length >= 4) {
          break;
        }
      }
      findings.push(
        (
          'The page overflows horizontally at ' +
          viewportWidth +
          ' CSS pixels (document width ' +
          document.documentElement.scrollWidth +
          '). Outside bounds: ' +
          culprits.join('; ')
        ).slice(0, 1400),
      );
    }
    for (const layer of document.querySelectorAll('dialog:modal,:popover-open')) {
      const bounds = layer.getBoundingClientRect();
      if (
        bounds.left < -2 ||
        bounds.top < -2 ||
        bounds.right > viewportWidth + 2 ||
        bounds.bottom > document.documentElement.clientHeight + 2
      ) {
        findings.push('A dialog or popover extends beyond the viewport: ' + label(layer));
      }
    }
    const controls = document.querySelectorAll(
      'button,input:not([type="hidden"]),textarea,select,a[href],[role="button"],[role="combobox"]',
    );
    for (const control of controls) {
      if (!visible(control) || control.closest('[inert]')) {
        continue;
      }
      const bounds = control.getBoundingClientRect();
      if (bounds.width <= 1 || bounds.height <= 1) {
        findings.push('An interactive control has no usable size: ' + label(control));
      }
      const layer = control.closest('dialog:modal,:popover-open');
      let left = bounds.left;
      let right = bounds.right;
      let top = bounds.top;
      let bottom = bounds.bottom;
      // After a scrollport, check its frame against outer clipping ancestors.
      // Its offscreen children remain reachable by scrolling inside that frame.
      for (let parent = control.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const rectangle = parent.getBoundingClientRect();
        const cutsHorizontal =
          /^(hidden|clip)$/.test(style.overflowX) &&
          (right > rectangle.right + 2 || left < rectangle.left - 2);
        const cutsVertical =
          /^(hidden|clip)$/.test(style.overflowY) &&
          (bottom > rectangle.bottom + 2 || top < rectangle.top - 2);
        if (cutsHorizontal || cutsVertical) {
          findings.push('A control is clipped by a non-scrolling container: ' + label(control));
          break;
        }
        if (/^(auto|scroll)$/.test(style.overflowX)) {
          left = rectangle.left;
          right = rectangle.right;
        }
        if (/^(auto|scroll)$/.test(style.overflowY)) {
          top = rectangle.top;
          bottom = rectangle.bottom;
        }
        if (parent === layer) {
          break;
        }
      }
      if (findings.length >= 20) {
        break;
      }
    }
    return findings;
  });
  return findingsSchema.parse(result);
}

async function accessibilityFindings(page: Page): Promise<string[]> {
  // Only this bundled scanner runs through DevTools. Manifest values never
  // become executable source, and the page receives no host bindings.
  await page.evaluate(axe.source);
  const result: unknown = await page.evaluate(`window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice'] }
  }).then(function (results) {
    return results.violations.slice(0, 100).map(function (violation) {
      return { id: violation.id, help: violation.help.slice(0, 500),
        targets: violation.nodes.slice(0, 5).map(function (node) { return node.target.join(' ').slice(0, 500); }) };
    });
  })`);
  return axeFindingsSchema
    .parse(result)
    .map(
      (violation) =>
        'Accessibility ' + violation.id + ': ' + violation.help + ' [' + violation.targets.join(', ') + ']',
    );
}

async function focusBaseline(page: Page, clearFocus: boolean) {
  return page.evaluateHandle((clearFocus) => {
    if (clearFocus && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    const signature = (element: Element) => {
      const style = getComputedStyle(element);
      return [
        style.outlineStyle,
        style.outlineWidth,
        style.outlineColor,
        style.boxShadow,
        style.borderColor,
        style.backgroundColor,
      ].join('|');
    };
    return {
      signature,
      styles: new Map(Array.from(document.querySelectorAll('*'), (element) => [element, signature(element)])),
    };
  }, clearFocus);
}

async function focusedElementFindings(
  page: Page,
  baseline: Awaited<ReturnType<typeof focusBaseline>>,
): Promise<string[]> {
  const result: unknown = await page.evaluate((baseline) => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element === document.body) {
      return [];
    }
    const label =
      element.id || element.getAttribute('aria-label') || element.innerText.slice(0, 60) || element.tagName;
    const rectangle = element.getBoundingClientRect();
    const centerX = Math.max(0, Math.min(innerWidth - 1, rectangle.left + rectangle.width / 2));
    const centerY = Math.max(0, Math.min(innerHeight - 1, rectangle.top + rectangle.height / 2));
    const hit = document.elementFromPoint(centerX, centerY);
    const findings: string[] = [];
    if (!hit || (!element.contains(hit) && !hit.contains(element))) {
      findings.push('Keyboard focus is obscured: ' + label);
    }
    let indicator = false;
    for (
      let candidate: HTMLElement | null = element, depth = 0;
      candidate && depth < 4;
      candidate = candidate.parentElement, depth++
    ) {
      const style = getComputedStyle(candidate);
      const changed =
        baseline.styles.has(candidate) && baseline.styles.get(candidate) !== baseline.signature(candidate);
      const outline =
        style.outlineStyle !== 'none' &&
        parseFloat(style.outlineWidth) >= 1 &&
        style.outlineColor !== 'rgba(0, 0, 0, 0)';
      if (outline || (changed && style.boxShadow !== 'none')) {
        indicator = true;
        break;
      }
    }
    if (!indicator) {
      findings.push('Keyboard focus needs a visible outline or focus ring: ' + label);
    }
    return findings;
  }, baseline);
  return findingsSchema.parse(result);
}

async function keyboardFindings(page: Page): Promise<string[]> {
  const findings: string[] = [];
  const baseline = await focusBaseline(page, true);
  try {
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press('Tab');
      findings.push(...(await focusedElementFindings(page, baseline)));
    }
  } finally {
    await baseline.dispose();
  }
  return [...new Set(findings)];
}

// Responsive layouts can render the same control in both navigation bars.
// Resolve the actual target on this viewport, retaining ambiguity for two visible matches.
function visibleControl(selector: string, value?: string) {
  const matches = Array.from(document.querySelectorAll(selector)).filter(
    (element) => element.getClientRects().length && element.checkVisibility({ checkVisibilityCSS: true }),
  );
  const target = matches[0];
  if (matches.length !== 1 || !target) {
    return null;
  }
  if (
    value !== undefined &&
    !((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.value === value)
  ) {
    return null;
  }
  return target;
}

export function matchesJourneyExpectation(
  expected: Extract<BrowserJourney['steps'][number], { type: 'expect' }>,
) {
  const elements = Array.from(document.querySelectorAll(expected.selector));
  if (expected.count !== undefined && elements.length !== expected.count) {
    return false;
  }
  const matchByContent =
    expected.count === undefined && (expected.text !== undefined || expected.value !== undefined);
  const matches = elements.filter((element) => {
    const style = getComputedStyle(element);
    const visible =
      element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    if (expected.visible !== undefined && visible !== expected.visible) {
      return false;
    }
    let text = element.textContent ?? '';
    if (matchByContent && elements.length > 1 && expected.visible !== false) {
      if (!visible || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        return false;
      }
      if (element instanceof HTMLElement) {
        text = element.innerText;
      }
    }
    if (expected.text !== undefined && !text.includes(expected.text)) {
      return false;
    }
    if (
      expected.value !== undefined &&
      (!(
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ) ||
        element.value !== expected.value)
    ) {
      return false;
    }
    return expected.focused === undefined || (document.activeElement === element) === expected.focused;
  });
  // A text or value assertion identifies one record among siblings. An explicit
  // count applies to the whole selector and every selected element must match.
  if (matchByContent) {
    return matches.length === 1;
  }
  return matches.length === elements.length && elements.length === (expected.count ?? 1);
}

async function executeStep(page: Page, step: BrowserJourney['steps'][number]): Promise<void> {
  if (step.type === 'reload') {
    await page.reload({ waitUntil: 'networkidle0', timeout: operationTimeout });
    return;
  }
  if (step.type === 'press') {
    if (step.key === 'Shift+Tab') {
      await page.keyboard.down('Shift');
      try {
        await page.keyboard.press('Tab');
      } finally {
        await page.keyboard.up('Shift');
      }
    } else {
      await page.keyboard.press(step.key);
    }
    return;
  }
  if (step.type === 'expect') {
    await page.waitForFunction(matchesJourneyExpectation, { timeout: operationTimeout }, step);
    return;
  }

  const control = await page.waitForFunction(visibleControl, { timeout: operationTimeout }, step.selector);
  try {
    if (!('asLocator' in control)) {
      throw new Error('No visible control matched: ' + step.selector);
    }
    if (step.type === 'click') {
      await control.click();
      return;
    }
    const editable = await control.evaluate(
      (element) =>
        (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
        !element.disabled &&
        !element.readOnly,
    );
    if (!editable) {
      throw new Error('Fill needs an enabled editable input or textarea: ' + step.selector);
    }
    // Keyboard select-all shortcuts vary with headless platform bindings.
    // Locator.fill owns clearing, input events and supported input types.
    const locator = control.asLocator().setTimeout(operationTimeout);
    if (step.value === '') {
      // The typing path has no keystroke for an empty value. The supported
      // direct path also dispatches input/change when clearing an old value.
      await locator.fill(step.value, { typingThreshold: 0 });
    } else {
      await locator.fill(step.value);
    }
    const filled = await page.waitForFunction(
      visibleControl,
      { timeout: operationTimeout },
      step.selector,
      step.value,
    );
    await filled.dispose();
  } finally {
    await control.dispose();
  }
}

/** Input can return while the replacement document is still fetching its entry module. */
async function dispatchPageAction(page: Page, step: BrowserJourney['steps'][number]) {
  let navigated = false;
  const observe = (request: HTTPRequest) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      navigated = true;
    }
  };
  page.on('request', observe);
  const controller = new AbortController();
  const navigation = page.waitForNavigation({
    waitUntil: 'domcontentloaded',
    timeout: operationTimeout,
    signal: controller.signal,
  });
  // Same-document actions cancel this listener after the input has been dispatched.
  void navigation.catch(() => {});
  try {
    await executeStep(page, step);
    // The renderer round trip also observes a navigation request queued by the
    // input event. DOMContentLoaded includes deferred and module script execution.
    const ready = await page.waitForFunction(
      () => {
        const timing = performance.getEntriesByType('navigation')[0];
        return (
          document.readyState === 'complete' ||
          (timing instanceof PerformanceNavigationTiming && timing.domContentLoadedEventEnd > 0)
        );
      },
      { timeout: operationTimeout },
    );
    await ready.dispose();
    if (navigated) {
      await navigation;
    }
    return navigated;
  } finally {
    controller.abort();
    page.off('request', observe);
  }
}

async function inspectDocument(
  page: Page,
  ownsPage: (url: URL) => boolean,
  instructions: readonly string[] | undefined,
  initial: boolean,
) {
  const read = async () => [
    ...(await renderFindings(page)),
    ...(await inspectInterfaceCopy(page, instructions, initial)),
    ...(await accessibilityFindings(page)),
  ];
  const controller = new AbortController();
  const navigation = page
    .waitForNavigation({
      waitUntil: 'domcontentloaded',
      timeout: operationTimeout,
      signal: controller.signal,
    })
    .catch(() => null);
  try {
    return await read();
  } catch (error) {
    // A saved form can redirect after its API reply, while axe is still
    // inspecting the old document. Only repeat reads after a real app navigation.
    if (!(error instanceof Error) || !error.message.includes('Execution context was destroyed')) {
      throw error;
    }
    const response = await navigation;
    if (!response?.ok() || !ownsPage(new URL(response.url()))) {
      throw error;
    }
    return await read();
  } finally {
    controller.abort();
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 1000);
  }
  return 'The browser operation failed without a readable error.';
}

export async function runBrowserJourneys(request: JourneyRequest): Promise<BrowserJourneyResult> {
  const journeys = browserJourneysSchema.parse(request.journeys);
  const findings = new Set<string>();
  const failures: string[] = [];
  const screenshots: string[] = [];
  let completed = 0;
  const backendEvidence: NonNullable<BrowserJourneyResult['backend']> = [];
  const allowed = new URL(request.url);
  const add = (context: string, message: string) => {
    if (findings.size < findingLimit) {
      findings.add((context + ': ' + message).slice(0, 1500));
    }
  };

  for (const viewport of viewports) {
    const cases: (BrowserJourney | undefined)[] = [undefined];
    if (viewport.name !== 'reflow') {
      cases.push(...journeys);
    }
    for (const [caseIndex, journey] of cases.entries()) {
      request.signal.throwIfAborted();
      const backend = request.backend;
      if (backend) {
        await backend.reset();
        backend.activity.start(journey?.steps);
      }
      const label = viewport.name + ' / ' + (journey?.name ?? 'baseline');
      const context = await request.browser.createBrowserContext({ downloadBehavior: { policy: 'deny' } });
      const domainErrors = new DomainRejections(allowed, Boolean(backend && journey), (finding) =>
        add(label, finding),
      );
      let failedPage: Page | undefined;
      let observers: Awaited<ReturnType<typeof observeJourneyPages>> | undefined;
      try {
        const page = await context.newPage();
        failedPage = page;
        page.setDefaultTimeout(operationTimeout);
        page.setDefaultNavigationTimeout(operationTimeout);
        await page.setViewport({
          width: viewport.width,
          height: viewport.height,
          isMobile: viewport.mobile,
          hasTouch: viewport.mobile,
        });
        observers = await observeJourneyPages(
          page,
          allowed,
          Boolean(request.frameworkRoutes),
          Boolean(backend),
          domainErrors,
          (finding) => add(label, finding),
        );
        await page.goto(request.url, { waitUntil: 'networkidle0' });
        const inspectedFindings = new Set<string>();
        const ownsPage = observers.ownsPage;
        const inspect = async (state: string) => {
          request.signal.throwIfAborted();
          for (const finding of await inspectDocument(
            page,
            ownsPage,
            request.copyInstructions,
            state === 'initial',
          )) {
            if (!inspectedFindings.has(finding)) {
              inspectedFindings.add(finding);
              add(label + ' / ' + state, finding);
            }
          }
          request.signal.throwIfAborted();
        };
        await inspect('initial');
        if (journey) {
          for (const [stepIndex, step] of journey.steps.entries()) {
            request.signal.throwIfAborted();
            try {
              await domainErrors.begin(page, step, journey.steps[stepIndex + 1]);
              if (step.type === 'reload' && backend) {
                // Let the form's write finish before checking the server's response evidence.
                await page.waitForNetworkIdle({ timeout: operationTimeout });
              }
              if (step.type === 'reload' && backend?.activity.beginReload()) {
                // Read persisted state without a service worker, browser cache or client database.
                const session = await page.createCDPSession();
                try {
                  await page.setBypassServiceWorker(true);
                  await page.setCacheEnabled(false);
                  await page.evaluate(() => {
                    sessionStorage.clear();
                    window.name = '';
                  });
                  await session.send('Storage.clearDataForOrigin', {
                    origin: allowed.origin,
                    storageTypes: 'all',
                  });
                  const capability = allowed.pathname.split('/')[1];
                  if (request.frameworkRoutes && capability && /^[a-f0-9]{32}$/.test(capability)) {
                    // Framework navigation has left the capability-bearing entry.
                    // Restore only the host's preview cookie, never app state.
                    await context.setCookie({
                      name: 'miter_preview',
                      value: capability,
                      domain: allowed.hostname,
                      path: '/',
                      httpOnly: true,
                      sameSite: 'Strict',
                    });
                  }
                } finally {
                  await session.detach();
                }
              }
              if (step.type === 'press') {
                const baseline = await focusBaseline(page, false);
                try {
                  const navigated = await dispatchPageAction(page, step);
                  // The pre-keypress element handles belong to the old document.
                  if (!navigated) {
                    for (const finding of await focusedElementFindings(page, baseline)) {
                      add(label + ' / step ' + (stepIndex + 1), finding);
                    }
                  }
                } finally {
                  await baseline.dispose();
                }
              } else if (step.type === 'click') {
                await dispatchPageAction(page, step);
              } else {
                await executeStep(page, step);
              }
              await domainErrors.asserted(page, step);
              if (backend?.activity.completed(step) && step.type === 'expect' && step.visible !== true) {
                await executeStep(page, { ...step, visible: true });
              }
            } catch (error) {
              request.signal.throwIfAborted();
              let detail = errorText(error).slice(0, 200);
              if (step.type === 'fill') {
                detail = 'The input did not accept the requested value.';
              }
              let evidence = '';
              try {
                evidence = await failureEvidence(page, step);
              } catch (diagnosticError) {
                evidence = 'Could not inspect the failed state: ' + errorText(diagnosticError).slice(0, 150);
              }
              let action = step.type;
              if ('selector' in step) {
                action += ' ' + step.selector;
              }
              throw new Error('Step ' + (stepIndex + 1) + ' ' + action + ': ' + detail + ' ' + evidence, {
                cause: error,
              });
            }
            await inspect('step ' + (stepIndex + 1));
          }
          if (backend?.activity.verified && viewport.name !== 'reflow') {
            backendEvidence.push({ device: viewport.name, journey: journey.name });
          }
          completed++;
        } else {
          for (const finding of await keyboardFindings(page)) {
            add(label, finding);
          }
        }
        const screenshot = path.join(request.reportDirectory, viewport.name + '-' + caseIndex + '.png');
        await captureScreenshot(page, screenshot);
        screenshots.push(screenshot);
        if (!journey && viewport.name !== 'reflow') {
          for (const finding of await page.evaluate(checkNativeValidation)) {
            add(label, finding);
          }
        }
        await observers.inspectChildren(async (secondary) => {
          for (const finding of [
            ...(await renderFindings(secondary)),
            ...(await inspectInterfaceCopy(secondary, request.copyInstructions)),
            ...(await accessibilityFindings(secondary)),
          ]) {
            add(label + ' / app tab', finding);
          }
        });
      } catch (error) {
        request.signal.throwIfAborted();
        if (error instanceof Error) {
          failures.push((label + ': ' + error.message).slice(0, 1500));
        } else {
          failures.push((label + ': ' + errorText(error)).slice(0, 1500));
        }
        if (failedPage) {
          try {
            const screenshot = path.join(
              request.reportDirectory,
              viewport.name + '-' + caseIndex + '-failed.png',
            );
            await captureScreenshot(failedPage, screenshot);
            screenshots.push(screenshot);
          } catch (screenshotError) {
            add(label, 'Could not capture the failed state: ' + errorText(screenshotError));
          }
        }
      } finally {
        try {
          await observers?.dispose();
          domainErrors.flush();
        } finally {
          await context.close();
        }
      }
    }
  }
  request.signal.throwIfAborted();
  if (request.backend) {
    for (const device of ['desktop', 'mobile']) {
      if (!backendEvidence.some((item) => item.device === device)) {
        failures.push(
          device +
            ': Add a journey that enters a new record value, submits it to the API, reloads, and asserts the same value returned by the API in visible text or a field.',
        );
      }
    }
  }
  return browserJourneyResultSchema.parse({
    ok: findings.size === 0 && failures.length === 0,
    findings: [...new Set([...failures, ...findings])].slice(0, findingLimit),
    screenshots,
    ...(request.backend && { backend: backendEvidence }),
    journeys: completed,
  });
}
