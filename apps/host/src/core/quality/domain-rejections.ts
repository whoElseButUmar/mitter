import type { ConsoleMessage, HTTPRequest, HTTPResponse, Page } from 'puppeteer-core';
import type { BrowserJourney } from './browser-contract.js';

type Step = BrowserJourney['steps'][number];
type Assertion = Extract<Step, { type: 'expect' }>;
type Pending = {
  assertion: Assertion;
  before: string;
  mutations: Set<HTTPRequest>;
  response?: HTTPResponse;
  diagnostic?: { url: string; status: number; text: string };
};

async function visibleText(page: Page, selector: string): Promise<string> {
  return page.evaluate((selector) => {
    const elements = document.querySelectorAll(selector);
    const element = elements[0];
    if (
      elements.length !== 1 ||
      !(element instanceof HTMLElement) ||
      !element.getClientRects().length ||
      !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    ) {
      return '';
    }
    return element.innerText.trim();
  }, selector);
}

function httpFailure(response: HTTPResponse): string {
  return 'HTTP ' + response.status() + ': ' + response.url().slice(0, 250);
}

/** An expected validation error is evidence only for the immediately following
 * positive text assertion. All other requests, statuses and console output are
 * reported normally, including any error raised by application JavaScript. */
export class DomainRejections {
  private pending: Pending | undefined;
  private readonly api: string;
  constructor(
    private readonly entry: URL,
    private readonly enabled: boolean,
    private readonly report: (finding: string) => void,
  ) {
    this.api = '/' + entry.pathname.split('/')[1] + '/api/';
  }

  async begin(page: Page, action: Step, next: Step | undefined) {
    if (
      !this.enabled ||
      next?.type !== 'expect' ||
      !next.text?.trim() ||
      (next.count ?? 1) !== 1 ||
      next.visible === false ||
      next.focused === false ||
      !(action.type === 'click' || (action.type === 'press' && ['Space', 'Enter'].includes(action.key)))
    ) {
      return;
    }
    this.pending = { assertion: next, before: await visibleText(page, next.selector), mutations: new Set() };
  }

  request(request: HTTPRequest) {
    const stage = this.pending;
    if (
      !stage ||
      !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) ||
      !['xhr', 'fetch'].includes(request.resourceType())
    ) {
      return;
    }
    const url = new URL(request.url());
    if (
      url.origin === this.entry.origin &&
      (url.pathname.startsWith('/api/') || url.pathname.startsWith(this.api))
    ) {
      // More than one mutation makes the source of the asserted feedback ambiguous.
      if (stage.mutations.size < 2) {
        stage.mutations.add(request);
      }
    }
  }

  response(response: HTTPResponse) {
    if (response.status() < 400) {
      return;
    }
    const stage = this.pending;
    if (
      stage &&
      !stage.response &&
      stage.mutations.has(response.request()) &&
      [400, 404, 409, 422].includes(response.status()) &&
      response.headers()['content-type']?.split(';')[0]?.trim().toLowerCase() === 'application/json'
    ) {
      stage.response = response;
      return;
    }
    this.report(httpFailure(response));
  }

  console(message: ConsoleMessage) {
    if (message.type() !== 'error') {
      return;
    }
    const text = message.text();
    const stage = this.pending;
    const url = message.location().url;
    // Chromium's network Log entry has no execution frame or console arguments.
    // A console.error from project JavaScript always remains a finding.
    const native =
      /^Failed to load resource: the server responded with a status of (400|404|409|422) \([a-z ]*\)$/i.exec(
        text,
      );
    if (
      stage &&
      !stage.diagnostic &&
      native &&
      url &&
      message.frame() === null &&
      !message.worker() &&
      message.args().length === 0 &&
      [...stage.mutations].some((request) => request.url() === url)
    ) {
      stage.diagnostic = { url, status: Number(native[1]), text };
      return;
    }
    this.report('Console error: ' + text.slice(0, 1000));
  }

  async asserted(page: Page, step: Step) {
    const stage = this.pending;
    if (!stage || step !== stage.assertion) {
      return;
    }
    const response = stage.response;
    if (response && stage.mutations.size === 1 && stage.assertion.text) {
      try {
        const value: unknown = await response.json();
        if (
          value &&
          typeof value === 'object' &&
          'error' in value &&
          typeof value.error === 'string' &&
          value.error.includes(stage.assertion.text.trim()) &&
          value.error !== stage.before &&
          value.error === (await visibleText(page, stage.assertion.selector))
        ) {
          delete stage.response;
          if (stage.diagnostic?.url === response.url() && stage.diagnostic.status === response.status()) {
            delete stage.diagnostic;
          }
        }
      } catch {
        // A missing/read-failed JSON body cannot establish an expected rejection.
      }
    }
    this.flush();
  }

  flush() {
    if (this.pending?.response) {
      this.report(httpFailure(this.pending.response));
    }
    if (this.pending?.diagnostic) {
      this.report('Console error: ' + this.pending.diagnostic.text.slice(0, 1000));
    }
    this.pending = undefined;
  }
}
