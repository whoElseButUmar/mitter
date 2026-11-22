import { APP_VERSION } from './constants.js';

declare const __MITER_BUILD_ID__: string;

function compiledBuildId(): string {
  if (typeof __MITER_BUILD_ID__ === 'string') {
    return __MITER_BUILD_ID__;
  }
  return 'source';
}

export const BUILD_ID: string = compiledBuildId();

export function matchesBuild(version: string | undefined, buildId?: string): boolean {
  return (
    version === APP_VERSION && (buildId === BUILD_ID || (buildId === undefined && BUILD_ID === 'source'))
  );
}

export function describeBuild(version: string | undefined, buildId?: string): string {
  return (version || 'unknown version') + ' (build ' + (buildId || 'unknown') + ')';
}
