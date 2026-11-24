import { Show } from 'solid-js';
import { APP_VERSION, BUILD_ID, describeBuild, matchesBuild } from '../../../../packages/protocol/src/index';
import type { ConnectionBuilds } from '../client';
import { hasBuildMismatch } from '../ui/connection-help';
import type { Readiness } from '../../../../packages/protocol/src/rpc';
import { createReadiness } from '../ui/readiness';
import type { ViewRPC } from '../ui/rpc';
import { ConnectionGuide } from './ConnectionGuide';
import { Icon } from '../icons';

export function ReadinessDetails(props: { report: Readiness }) {
  return (
    <details class="readiness-details setup-disclosure" aria-label="Available checks">
      <summary>
        <Icon name="down" />
        Automatic checks
      </summary>
      <p>{props.report.webChecks.detail}</p>
      <Show when={props.report.webChecks.hint}>
        <p class="setup-attention">{props.report.webChecks.hint}</p>
      </Show>
      <dl>
        <div>
          <dt>Skills</dt>
          <dd>
            Caveman and No AI Slop guide writing. Coding tasks also use Ponytail and engineering defaults. UI
            tasks include app design.
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{props.report.checks.source.detail}</dd>
        </div>
        <div>
          <dt>Domain tests</dt>
          <dd>{props.report.checks.domain.detail}</dd>
        </div>
        <div>
          <dt>Browser testing</dt>
          <dd>{props.report.checks.browser.detail}</dd>
        </div>
      </dl>
      <p class="muted small">{props.report.notice}</p>
    </details>
  );
}

function BuildVersions(props: { builds: ConnectionBuilds | undefined; mismatch: boolean }) {
  const helper = () => {
    const build = props.builds?.helper;
    if (build) {
      return describeBuild(build.version, build.buildId);
    }
    return 'Not reported';
  };
  const differentBackground = () => {
    const build = props.builds?.background;
    if (build && !matchesBuild(build.version, build.buildId)) {
      return build;
    }
    return undefined;
  };
  return (
    <details class="setup-disclosure build-versions" open={props.mismatch}>
      <summary>
        <Icon name="down" />
        Build versions
      </summary>
      <dl class="health-details">
        <dt>Extension</dt>
        <dd>{describeBuild(APP_VERSION, BUILD_ID)}</dd>
        <Show when={differentBackground()}>
          {(build) => (
            <>
              <dt>Background worker</dt>
              <dd>{describeBuild(build().version, build().buildId)}</dd>
            </>
          )}
        </Show>
        <dt>Local helper</dt>
        <dd>{helper()}</dd>
      </dl>
    </details>
  );
}

export function SetupPanel(props: {
  connected: boolean;
  builds?: ConnectionBuilds | undefined;
  error: string;
  rpc: ViewRPC;
  reconnect: () => void;
  reload: () => void;
  openProject: () => void;
  createProject: () => void;
  newTask: () => void;
  projectName?: string | undefined;
}) {
  const mismatch = () => hasBuildMismatch(props.builds);
  const ready = () => props.connected && !mismatch();
  const readiness = createReadiness(ready, props.rpc);

  return (
    <div class="setup-panel">
      <Show
        when={ready()}
        fallback={
          <ConnectionGuide
            error={props.error}
            builds={props.builds}
            reconnect={props.reconnect}
            reload={props.reload}
          />
        }
      >
        <div class="setup-overview">
          <div class="setup-current">
            <p class="setup-connected-label">
              <span class="state-dot" aria-hidden="true" />
              Local helper connected
            </p>
            <Show when={props.projectName} fallback={<h1>Start your project</h1>}>
              {(name) => <p class="setup-project-name">{name()}</p>}
            </Show>
          </div>
          <div class="button-row home-actions">
            <Show
              when={props.projectName}
              fallback={
                <>
                  <button type="button" class="primary" onClick={props.createProject}>
                    New project
                  </button>
                  <button type="button" onClick={props.openProject}>
                    Open project
                  </button>
                </>
              }
            >
              <button type="button" class="primary" onClick={() => props.newTask()}>
                New task
              </button>
              <button type="button" onClick={props.openProject}>
                Open another project
              </button>
            </Show>
          </div>
        </div>
        <Show when={!props.projectName}>
          <p class="setup-account-note">Use the Chrome profile where you’re signed in to ChatGPT.</p>
        </Show>
        <Show when={readiness.report()}>
          {(report) => (
            <>
              <Show when={report().webChecks.status !== 'ready'}>
                <div class="setup-attention" role="status">
                  <strong>Automatic checks need setup</strong>
                  <p>{report().webChecks.hint || report().webChecks.detail}</p>
                  <button
                    type="button"
                    disabled={readiness.loading()}
                    onClick={() => void readiness.refresh()}
                  >
                    Check again
                  </button>
                </div>
              </Show>
              <ReadinessDetails report={report()} />
            </>
          )}
        </Show>
        <Show when={readiness.loading()}>
          <p class="muted" role="status">
            Checking local requirements…
          </p>
        </Show>
        <Show when={readiness.error()}>
          <p role="status">Could not check local requirements.</p>
          <details class="setup-disclosure">
            <summary>
              <Icon name="down" />
              Details
            </summary>
            <pre>{readiness.error()}</pre>
          </details>
          <button type="button" onClick={() => void readiness.refresh()}>
            Check again
          </button>
        </Show>
      </Show>
      <BuildVersions builds={props.builds} mismatch={mismatch()} />
    </div>
  );
}
