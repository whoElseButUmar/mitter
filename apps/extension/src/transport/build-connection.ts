import { APP_VERSION, BUILD_ID, describeBuild } from '../../../../packages/protocol/src/index.js';

export type PeerBuild = { version: string; buildId?: string | undefined };
export type ConnectionBuilds = { background?: PeerBuild; helper?: PeerBuild };

export function hostMismatch(version: string | undefined, buildId?: string): string {
  return (
    'Local helper ' +
    describeBuild(version, buildId) +
    ' differs from the Miter background ' +
    describeBuild(APP_VERSION, BUILD_ID) +
    '. Finish setup, then reload Miter to connect the matching local host.'
  );
}

export function viewMismatch(view: PeerBuild, background: PeerBuild): string {
  return (
    'Miter background version ' +
    describeBuild(background.version, background.buildId) +
    ' differs from workspace ' +
    describeBuild(view.version, view.buildId) +
    '. Open chrome://extensions, click Reload on Miter, then reopen the workspace. No operation was sent.'
  );
}

export function diagnosticRequest(method: string): boolean {
  return ['state', 'system.health', 'system.readiness', 'debug.read'].includes(method);
}

// These dedicated ports have no UI handshake. A release-specific name prevents
// a stale terminal or reset document from writing through another running build.
export function auxiliaryPort(base: string): string {
  if (BUILD_ID === 'source') {
    return base;
  }
  return base + ':' + APP_VERSION + ':' + BUILD_ID;
}
