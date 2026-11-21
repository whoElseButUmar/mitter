import type { ConsoleMessage, Page, PageEvents, Target } from 'puppeteer-core';
import { errorMessage } from '../types.js';
import { DomainRejections } from './domain-rejections.js';

const maxChildTabs = 4;

export async function observeJourneyPages(
  main: Page,
  entry: URL,
  frameworkRoutes: boolean,
  backend: boolean,
  mainErrors: DomainRejections,
  report: (finding: string) => void,
) {
  const prefix = '/' + entry.pathname.split('/')[1] + '/';
  const ownsPage = (url: URL) =>
    url.origin === entry.origin && (frameworkRoutes || url.pathname.startsWith(prefix));
  const context = main.browserContext();
  const others = new Set<Page>();
  const pending = new Set<Promise<void>>();
  const cleanups = new Set<() => void>();
  const childErrors = new DomainRejections(entry, false, report);
  const childConsole = (message: ConsoleMessage) => {
    if (message.page() && message.page() !== main) {
      childErrors.console(message);
    }
  };
  let opened = 0;

  async function watch(page: Page) {
    const session = await page.createCDPSession();
    const removals: (() => void)[] = [];
    const listen = <K extends keyof PageEvents & string>(
      name: K,
      callback: (event: PageEvents[K]) => void,
    ) => {
      page.on(name, callback);
      removals.push(() => page.off(name, callback));
    };
    const cleanup = () => {
      for (const remove of removals) {
        remove();
      }
      session.removeAllListeners();
      others.delete(page);
      cleanups.delete(cleanup);
    };
    cleanups.add(cleanup);
    listen('close', cleanup);
    let errors = childErrors;
    if (page === main) {
      errors = mainErrors;
      listen('pageerror', (error) => report('JavaScript error: ' + errorMessage(error).slice(0, 1000)));
      listen('console', (message) => errors.console(message));
    } else {
      // Enabling a fresh Runtime session replays exceptions from the child's first script.
      session.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
        const message = exceptionDetails.exception?.description ?? exceptionDetails.text;
        report('JavaScript error in app tab: ' + message.slice(0, 1000));
      });
      await session.send('Runtime.enable');
      const viewport = main.viewport();
      if (viewport) {
        // Apply the checked viewport without Puppeteer's automatic mobile-mode reload.
        await session.send('Emulation.setDeviceMetricsOverride', {
          width: viewport.width,
          height: viewport.height,
          mobile: viewport.isMobile ?? false,
          deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
        });
        await session.send('Emulation.setTouchEmulationEnabled', { enabled: viewport.hasTouch ?? false });
      }
    }
    listen('dialog', (dialog) => {
      report('A browser-native dialog interrupted the journey. Use the shared styled dialog.');
      void dialog.dismiss().catch((error: unknown) => report(errorMessage(error)));
    });
    listen('requestfailed', (resource) =>
      report(
        'Resource failed: ' + resource.url().slice(0, 250) + ' ' + (resource.failure()?.errorText ?? ''),
      ),
    );
    listen('response', (response) => errors.response(response));
    await page.setRequestInterception(true);
    listen('request', (resource) => {
      errors.request(resource);
      const url = new URL(resource.url());
      const icon = resource.method() === 'GET' && url.pathname === '/favicon.ico' && !url.search;
      const local =
        ownsPage(url) ||
        (url.origin === entry.origin && (icon || (backend && url.pathname.startsWith('/api/'))));
      const embedded = url.protocol === 'data:' || (url.protocol === 'blob:' && url.origin === entry.origin);
      let operation: Promise<void>;
      if (local || embedded) {
        operation = resource.continue();
      } else {
        report('The app requested an unsupported external resource: ' + resource.url().slice(0, 250));
        operation = resource.abort();
      }
      void operation.catch((error: unknown) => {
        if (!page.isClosed()) {
          report('Request handling failed: ' + errorMessage(error));
        }
      });
    });
    session.on('Page.windowOpen', ({ url, userGesture }) => {
      if (!userGesture || !URL.canParse(url) || !ownsPage(new URL(url))) {
        report('Open a new app tab only from a user action and point it to a page in this preview.');
      }
    });
    await session.send('Page.enable');
  }

  async function attach(target: Target, withinLimit: boolean) {
    const page = await target.page();
    if (!page || page.isClosed()) {
      return;
    }
    if (!withinLimit || !ownsPage(new URL(page.url()))) {
      if (withinLimit) {
        report('A new window opened outside the preview. Keep the journey on the app’s local address.');
      } else {
        report('A browser journey opened more than ' + maxChildTabs + ' additional app tabs.');
      }
      await page.close();
      return;
    }
    await watch(page);
    if (page.isClosed()) {
      return;
    }
    others.add(page);
    // The declared controls remain on the original tab.
    await main.bringToFront();
  }

  const targetCreated = (target: Target) => {
    if (target.type() !== 'page') {
      return;
    }
    const ready = attach(target, ++opened <= maxChildTabs).catch((error: unknown) =>
      report('Could not check the new app tab: ' + errorMessage(error)),
    );
    pending.add(ready);
    void ready.finally(() => pending.delete(ready));
  };
  await watch(main);
  // The origin-only audit proxy also bounds the child's initial navigation.
  context.on('console', childConsole);
  context.on('targetcreated', targetCreated);
  return {
    ownsPage,
    async inspectChildren(inspect: (page: Page) => Promise<void>) {
      const inspected = new Set<Page>();
      while (true) {
        while (pending.size) {
          await Promise.all(pending);
        }
        const page = [...others].find((child) => !inspected.has(child) && !child.isClosed());
        if (!page) {
          return;
        }
        inspected.add(page);
        // Puppeteer's response listener starts after the first navigation in a new tab.
        const status = await page.evaluate(() => {
          const [navigation] = performance.getEntriesByType('navigation');
          if (navigation instanceof PerformanceNavigationTiming) {
            return navigation.responseStatus;
          }
          return 0;
        });
        if (status >= 400) {
          report('App tab navigation returned HTTP ' + status + '.');
        }
        await inspect(page);
      }
    },
    async dispose() {
      context.off('targetcreated', targetCreated);
      await Promise.all(pending);
      context.off('console', childConsole);
      for (const cleanup of cleanups) {
        cleanup();
      }
      // The owning journey closes its isolated context and all CDP sessions next.
    },
  };
}
