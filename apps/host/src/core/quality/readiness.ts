import { constants, promises as fs } from 'node:fs';
import {
  readinessSchema,
  type Readiness,
  type ReadinessCheck,
} from '../../../../../packages/protocol/src/rpc.js';
import { browserExecutable } from './browser-executable.js';

export const QUALITY_SANDBOX = '/usr/bin/sandbox-exec';
const MINIMUM_TEST_NODE = 26;

type QualityRuntime = {
  node: string;
  platform: string;
  architecture: string;
  sandboxExecutable: boolean;
  browserExecutable: boolean;
};

export function qualityTestAvailability(runtime: QualityRuntime): ReadinessCheck {
  const major = Number(runtime.node.replace(/^v/, '').split('.')[0]);

  if (runtime.platform !== 'darwin' || !Number.isSafeInteger(major) || major < MINIMUM_TEST_NODE) {
    return {
      status: 'unavailable',
      detail: 'Isolated quality tests require macOS sandbox-exec and Node.js 26 or newer. No tests ran.',
      hint:
        'Use a macOS host with Node.js 26 or newer for automatic web-app completion. ' +
        'Other tasks can still use the available source checks.',
    };
  }

  if (!runtime.sandboxExecutable) {
    return {
      status: 'unavailable',
      detail: 'macOS sandbox-exec is unavailable or not executable. No tests ran.',
      hint: 'Check /usr/bin/sandbox-exec and its execute permission. Node permissions alone are insufficient.',
    };
  }

  return {
    status: 'ready',
    detail: 'Node and the macOS sandbox executable are available. Isolation is probed before each test run.',
  };
}

export function buildReadiness(runtime: QualityRuntime): Readiness {
  const domain = qualityTestAvailability(runtime);
  let browser: ReadinessCheck = {
    status: 'unavailable',
    detail:
      'Chrome was not found at a supported installation path. Browser journeys and Lighthouse cannot run.',
    hint: 'Install Google Chrome in its standard location, then check setup again.',
  };

  if (runtime.browserExecutable) {
    browser = {
      status: 'ready',
      detail:
        'Chrome is available for automatic browser journeys and Lighthouse audits. Launch is verified during execution.',
    };
  }

  let webChecks = domain;

  if (domain.status === 'ready') {
    webChecks = browser;

    if (browser.status === 'ready') {
      webChecks = {
        status: 'ready',
        detail:
          'Source checks, isolated domain tests, Chrome journeys and Lighthouse prerequisites are available.',
      };
    }
  }

  return readinessSchema.parse({
    version: 1,
    node: runtime.node,
    platform: runtime.platform,
    architecture: runtime.architecture,
    webChecks,
    checks: {
      source: {
        status: 'ready',
        detail: 'Bounded source rules and JavaScript syntax checks are available without running app code.',
      },
      domain,
      browser,
    },
    notice: 'Prerequisites only. No tests, isolation probe, browser or network request ran.',
  });
}

export async function inspectReadiness(): Promise<Readiness> {
  let sandboxExecutable = false;
  const installedBrowser = await browserExecutable();

  if (process.platform === 'darwin') {
    try {
      await fs.access(QUALITY_SANDBOX, constants.X_OK);
      sandboxExecutable = true;
    } catch {
      // A failed availability check must not authorize supplied code to execute.
    }
  }

  return buildReadiness({
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    sandboxExecutable,
    browserExecutable: installedBrowser !== undefined,
  });
}
