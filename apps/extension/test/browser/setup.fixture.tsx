import { createSignal, onCleanup, type JSX } from 'solid-js';
import { readinessSchema } from '../../../../packages/protocol/src/rpc';
import { SetupPanel } from '../../src/views/SetupPanel';

const modes = [
  'ready',
  'missing',
  'unsupported',
  'version',
  'connecting',
  'disconnected',
  'background',
  'readiness-error',
];

function validateMode(mode: string) {
  if (!modes.includes(mode)) {
    throw new Error('Unknown setup fixture mode.');
  }
  return mode;
}

function connectionError(mode: string) {
  switch (mode) {
    case 'missing':
      return 'Specified native messaging host not found.';
    case 'version':
      return 'Reload Miter after setup to connect the matching local host.';
    case 'disconnected':
      return 'Native host has exited.';
    case 'background':
      return 'Miter’s background did not answer the workspace check.';
    default:
      return '';
  }
}

function readiness(mode: string) {
  let domainStatus = 'ready';
  let domainDetail = 'Isolated domain tests are available.';
  if (mode === 'unsupported') {
    domainStatus = 'unavailable';
    domainDetail = 'Web-app checks require Node.js 26 or newer on macOS.';
  }
  return readinessSchema.parse({
    version: 1,
    node: 'v26.5.1',
    platform: 'darwin',
    architecture: 'arm64',
    webChecks: { status: domainStatus, detail: domainDetail },
    checks: {
      source: { status: 'ready', detail: 'Source checks are available.' },
      domain: { status: domainStatus, detail: domainDetail },
      browser: { status: 'ready', detail: 'Chrome is available for automatic browser checks.' },
    },
    notice: 'These are requirements, not passing test results.',
  });
}

export function createSetupFixture(mount: (component: () => JSX.Element) => void) {
  const actions: string[] = [];
  let readinessCalls = 0;
  let reportMode = 'ready';
  let transition: ((mode: string) => void) | undefined;

  function show(initialMode: string) {
    validateMode(initialMode);
    actions.length = 0;
    readinessCalls = 0;
    reportMode = initialMode;
    mount(() => {
      const [mode, setMode] = createSignal(initialMode);
      const change = (next: string) => {
        reportMode = validateMode(next);
        setMode(next);
      };
      transition = change;
      onCleanup(() => {
        if (transition === change) {
          transition = undefined;
        }
      });
      return (
        <SetupPanel
          connected={['ready', 'unsupported', 'readiness-error'].includes(mode())}
          error={connectionError(mode())}
          rpc={async (method) => {
            if (method !== 'system.readiness') {
              throw new Error('Setup must not issue a task mutation: ' + method);
            }
            readinessCalls++;
            if (reportMode === 'readiness-error' && readinessCalls === 1) {
              throw new Error('Controlled readiness lookup failed.');
            }
            return readiness(reportMode);
          }}
          reconnect={() => {
            actions.push('reconnect');
          }}
          reload={() => actions.push('reload')}
          openProject={() => actions.push('folder')}
          createProject={() => actions.push('create')}
          newTask={() => actions.push('task')}
        />
      );
    });
  }

  return {
    show,
    transition(mode: string) {
      if (!transition) {
        throw new Error('Mount setup before changing its connection.');
      }
      transition(mode);
    },
    respondWith(mode: string) {
      reportMode = validateMode(mode);
    },
    actions: () => [...actions],
    inspect: () => ({ actions: [...actions], readinessCalls }),
  };
}
