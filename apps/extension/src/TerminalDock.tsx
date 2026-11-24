import { Icon } from './icons';
import { errorMessage } from './schemas/primitives';
import { createAnimationFrames } from './ui/animation-frames';
import { bindTerminalInput, readTerminalScreen } from './ui/terminal-session';
import { disposeTerminalScreen, type TerminalScreen as Screen } from './ui/terminal-screen';
import { createTerminalAppearance } from './ui/terminal-appearance';
import { terminalSettings } from './ui/terminal-settings';
import { TerminalSessionPicker } from './components/TerminalSessionPicker';
import { ElementPicker, type PickedElements } from './components/ElementPicker';
import { TooltipButton } from './components/TooltipButton';
import { AppRunOutput } from './components/AppRunOutput';
import {
  createTerminalRuns,
  runTabId,
  type SetupTerminalFocus,
  type TerminalRunFocus,
} from './ui/terminal-runs';
import type { ViewRPC } from './ui/rpc';
import { requireElement } from './ui/dom';
import { showConfirmation } from './ui/confirmation';
import {
  createSignal,
  createEffect,
  createMemo,
  createUniqueId,
  onMount,
  onCleanup,
  untrack,
  Show,
} from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalClient } from './terminal-client';
import type { TerminalInfo } from '../../../packages/terminal/src/protocol';
import type { AppRunSession } from '../../../packages/protocol/src/rpc';
import './terminal.css';

export function TerminalDock(props: {
  visible: boolean;
  projectId: string;
  workerId?: string;
  projectName: string;
  rpc: ViewRPC;
  runFocus?: TerminalRunFocus | undefined;
  setupFocus?: SetupTerminalFocus | undefined;
  editElements: (projectId: string, selection: PickedElements) => void;
  close: () => void;
}) {
  const frames = createAnimationFrames();
  const panelId = 'terminal-output-' + createUniqueId();

  let area: HTMLDivElement | undefined;
  let root: HTMLElement | undefined;
  let panel: HTMLDivElement | undefined;
  const [sessions, setSessions] = createSignal<TerminalInfo[]>([]);
  const [selected, setSelected] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [logsOpen, setLogsOpen] = createSignal(false);
  let sessionPicker: HTMLDivElement | undefined;
  const runs = createTerminalRuns({
    projectId: () => props.projectId,
    visible: () => props.visible,
    rpc: props.rpc,
  });
  const [pickTarget, setPickTarget] = createSignal<AppRunSession>();
  const selectedRun = () => runs.tabs().get(selected());
  const launchFailure = () => {
    const focus = props.runFocus;
    if (focus && focus.projectId === props.projectId && selected() === runTabId(focus.workerId, focus)) {
      return focus.failure?.();
    }
    return undefined;
  };
  let pendingRun = '';
  let pendingSetup: SetupTerminalFocus | undefined;
  let lastSetupFocus: SetupTerminalFocus | undefined;
  let lastFocus: TerminalRunFocus | undefined;

  const screens = new Map<string, Screen>();
  const attaching = new Map<string, symbol>();

  const lastByProject = new Map<string, string>();

  let alive = true;
  const listing = new Set<string>();
  let confirmationScope = new AbortController();
  let openingLink = false;
  const ending = new Set<string>();
  const client = new TerminalClient(() => {
    for (const screen of screens.values()) {
      screen.failed = true;
      screen.term.options.disableStdin = true;
    }
    setError(
      'Terminal connection closed. Shells cannot survive a host restart. Reopen the drawer to reconnect; input is never replayed.',
    );
  });

  const scope = () => sessions().filter((screen) => screen.projectId === props.projectId);
  const chosen = () => screens.get(selected());

  const captureScope = (screen?: Screen) => {
    const lifetime = confirmationScope;
    const projectId = props.projectId;
    const workerId = props.workerId;
    const sessionId = selected();
    return {
      projectId,
      workerId,
      signal: lifetime.signal,
      isCurrent: () =>
        alive &&
        props.visible &&
        confirmationScope === lifetime &&
        !lifetime.signal.aborted &&
        props.projectId === projectId &&
        props.workerId === workerId &&
        selected() === sessionId &&
        (!screen || (!screen.disposed && screens.get(sessionId) === screen)),
    };
  };

  const fail = (error: unknown) => {
    if (alive) {
      setError(errorMessage(error));
    }
  };

  const { prefs, ready } = createTerminalAppearance(
    (preferences) => {
      for (const screen of screens.values()) {
        Object.assign(screen.term.options, terminalSettings(preferences));
      }
      frames.schedule(fit);
    },
    fail,
    setError,
  );

  const fit = () => {
    const screen = chosen();
    if (screen && !screen.failed && props.visible && screen.el.offsetWidth > 0) {
      try {
        screen.fit.fit();
      } catch {}
    }
  };

  async function refresh() {
    if (!props.projectId || listing.has(props.projectId)) {
      return;
    }
    const projectId = props.projectId;
    listing.add(projectId);
    try {
      const rows = await client.request('terminal.list', {
        projectId,
      });
      if (alive) {
        setSessions((old) => [...old.filter((screen) => screen.projectId !== projectId), ...rows]);
        for (const [id, screen] of screens) {
          if (screen.info.projectId === projectId && !rows.some((session) => session.id === id)) {
            disposeTerminalScreen(screen);
            screens.delete(id);
            if (selected() === id) {
              setSelected('');
            }
          }
        }
      }
    } catch (event) {
      if (props.projectId === projectId && props.visible) {
        fail(event);
      }
    } finally {
      listing.delete(projectId);
    }
  }
  const choose = (id: string) => {
    const projectId = screens.get(id)?.info.projectId;
    if (projectId) {
      lastByProject.set(projectId, id);
    }
    if (projectId === props.projectId) {
      pendingRun = '';
      setSelected(id);
    }
  };

  const chooseRun = (id: string) => {
    pendingRun = '';
    lastByProject.set(props.projectId, id);
    setSelected(id);
  };

  async function openLink(sessionId: string, uri: string) {
    const screen = screens.get(sessionId);
    if (!screen || openingLink) {
      return;
    }
    const approval = captureScope(screen);
    openingLink = true;
    try {
      const linkURL = new URL(uri);
      if (!['https:', 'http:'].includes(linkURL.protocol)) {
        throw Error('Only HTTP(S) terminal links can be opened.');
      }
      const accepted = await showConfirmation({
        title: 'Open terminal link',
        message: 'Open this terminal link in your browser?\n' + linkURL.href,
        confirmLabel: 'Open link',
        signal: approval.signal,
        isCurrent: approval.isCurrent,
      });
      if (accepted && approval.isCurrent()) {
        await chrome.tabs.create({ url: linkURL.href });
      }
    } catch (event) {
      if (approval.isCurrent()) {
        fail(event);
      }
    } finally {
      openingLink = false;
    }
  }

  async function attach(info: TerminalInfo) {
    const attachment = captureScope();
    if (!attachment.isCurrent() || info.projectId !== attachment.projectId) {
      return;
    }
    const prior = screens.get(info.id);
    if (prior && !prior.failed) {
      choose(info.id);
      fit();
      return;
    }
    if (prior) {
      disposeTerminalScreen(prior);
      screens.delete(info.id);
    }
    const claim = Symbol();
    attaching.set(info.id, claim);
    try {
      await client.request('terminal.attach', { sessionId: info.id });
      if (attaching.get(info.id) !== claim) {
        return;
      }
      if (!attachment.isCurrent()) {
        // A hidden view must not keep an unseen setup session away from its next owner.
        if (alive) {
          await client.request('terminal.release', { sessionId: info.id });
        }
        return;
      }
    } finally {
      if (attaching.get(info.id) === claim) {
        attaching.delete(info.id);
      }
    }
    const term = new Terminal({
      ...terminalSettings(prefs()),
      allowProposedApi: false,
      allowTransparency: false,
      convertEol: false,
      logLevel: 'off',
      windowOptions: {},
      macOptionIsMeta: true,
      screenReaderMode: true,
      linkHandler: {
        activate: (_e, uri) => {
          void openLink(info.id, uri);
        },
      },
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    const el = document.createElement('div');
    el.className = 'terminal-screen';
    requireElement(area, 'TerminalDock area').append(el);
    term.open(el);
    const screen: Screen = {
      info,
      term,
      fit: addon,
      el,
      after: 0,
      polling: false,
      tail: Promise.resolve(),
      pending: 0,
      failed: false,
      exitShown: false,
      disposables: [],
      disposed: false,
    };
    screens.set(info.id, screen);
    bindTerminalInput(screen, {
      client,
      isCurrent: () =>
        alive &&
        props.visible &&
        props.projectId === info.projectId &&
        selected() === info.id &&
        screens.get(info.id) === screen,
      confirmationSignal: () => confirmationScope.signal,
      fail,
    });
    choose(info.id);
    frames.schedule(() => {
      if (!alive || screen.disposed || !props.visible || selected() !== info.id) {
        return;
      }
      fit();
      term.focus();
    });
    void read(screen);
  }
  const read = (screen: Screen) =>
    readTerminalScreen(screen, {
      client,
      isCurrent: () => alive && screens.get(screen.info.id) === screen,
      refresh,
      fail,
    });
  async function attachSetup(focus: SetupTerminalFocus) {
    const current = () =>
      alive &&
      props.visible &&
      pendingSetup === focus &&
      props.setupFocus === focus &&
      props.projectId === focus.projectId &&
      props.workerId === focus.workerId;
    try {
      const rows = await client.request('terminal.list', { projectId: focus.projectId });
      if (!current()) {
        return;
      }
      const session = rows.find(
        (row) =>
          row.id === focus.sessionId && row.projectId === focus.projectId && row.workerId === focus.workerId,
      );
      if (!session) {
        throw new Error('This setup terminal is no longer available. Return to the task to see the result.');
      }
      if (session.occupied && !screens.has(session.id)) {
        throw new Error('This setup terminal is open in another Miter window.');
      }
      setSessions((old) => [...old.filter((row) => row.projectId !== focus.projectId), ...rows]);
      await attach(session);
      if (current() && selected() === session.id) {
        screens.get(session.id)?.term.focus();
      }
    } catch (reason) {
      if (current()) {
        fail(reason);
      }
    } finally {
      if (pendingSetup === focus) {
        pendingSetup = undefined;
      }
    }
  }

  async function create() {
    if (busy() || !props.projectId) {
      return;
    }
    const approval = captureScope();
    setBusy(true);
    try {
      const accepted = await showConfirmation({
        title: 'Open local shell',
        message:
          'Open a real local shell?\n\nIt has your macOS/user permissions, not just access to this project. Commands you type run directly. Terminal contents are not sent to ChatGPT.',
        confirmLabel: 'Open shell',
        signal: approval.signal,
        isCurrent: approval.isCurrent,
      });
      if (!accepted || !approval.isCurrent()) {
        return;
      }
      setError('');
      const projectId = approval.projectId;
      const workerScope: { workerId?: string } = {};
      if (approval.workerId) {
        workerScope.workerId = approval.workerId;
      }

      const info = await client.request('terminal.create', {
        projectId,
        ...workerScope,
        cols: 80,
        rows: 18,
        confirm: true,
      });
      if (!approval.isCurrent()) {
        return;
      }
      await refresh();
      if (!approval.isCurrent()) {
        return;
      }
      await attach(info);
    } catch (event) {
      if (approval.isCurrent()) {
        fail(event);
      }
    } finally {
      if (alive) {
        setBusy(false);
      }
    }
  }
  async function end() {
    const screen = chosen();
    if (!screen || ending.has(screen.info.id)) {
      return;
    }
    const approval = captureScope(screen);
    ending.add(screen.info.id);
    try {
      const accepted = await showConfirmation({
        title: 'Close local shell',
        message: 'Close this shell and its attached terminal session? Running foreground work may stop.',
        confirmLabel: 'Close shell',
        signal: approval.signal,
        isCurrent: approval.isCurrent,
      });
      if (!accepted || !approval.isCurrent()) {
        return;
      }
      await client.request('terminal.close', {
        sessionId: screen.info.id,
        confirm: true,
      });
      if (!approval.isCurrent()) {
        return;
      }
      disposeTerminalScreen(screen);
      screens.delete(screen.info.id);
      setSelected('');
      lastByProject.delete(screen.info.projectId);
      await refresh();
    } catch (event) {
      if (approval.isCurrent()) {
        fail(event);
      }
    } finally {
      ending.delete(screen.info.id);
    }
  }
  onMount(() => {
    const resize = new ResizeObserver(fit);
    resize.observe(requireElement(root, 'TerminalDock root'));
    const timer = setInterval(() => {
      for (const screen of screens.values()) {
        void read(screen);
      }
    }, 80);
    onCleanup(() => {
      resize.disconnect();
      clearInterval(timer);
    });
  });

  createEffect(() => {
    props.projectId;
    props.workerId;
    props.visible;
    selected();
    setPickTarget(undefined);
    confirmationScope.abort();
    confirmationScope = new AbortController();
  });

  createEffect(() => {
    const projectId = props.projectId;
    const visible = props.visible;
    const focus = props.runFocus;
    const setup = props.setupFocus;
    setError('');
    if (
      setup &&
      visible &&
      projectId === setup.projectId &&
      props.workerId === setup.workerId &&
      setup !== lastSetupFocus
    ) {
      lastSetupFocus = setup;
      pendingSetup = setup;
      pendingRun = '';
      untrack(() => void attachSetup(setup));
      return;
    }
    pendingSetup = undefined;
    if (visible && focus && focus !== lastFocus && projectId === focus.projectId) {
      lastFocus = focus;
      pendingRun = runTabId(focus.workerId, focus);
      const requestedTab = pendingRun;
      lastByProject.set(projectId, requestedTab);
      setSelected(requestedTab);
      untrack(() => void runs.refresh());
      // The output panel stays mounted while the host allocates the session.
      // Move focus once for this explicit Run, never on log polls or drawer reopen.
      frames.schedule(() => {
        if (
          alive &&
          props.visible &&
          props.runFocus === focus &&
          selected() === requestedTab &&
          props.projectId === focus.projectId
        ) {
          const target = sessionPicker?.querySelector('[role="combobox"]:enabled') || panel;
          if (target instanceof HTMLElement) {
            target.focus();
          }
        }
      });
    } else {
      pendingRun = '';
      setSelected((visible && lastByProject.get(projectId)) || '');
    }
    frames.schedule(fit);
  });

  createEffect(() => {
    if (ready() && props.visible && props.projectId) {
      untrack(() => void refresh());
    }
  });

  createEffect(() => {
    const tabs = runs.tabs();
    const projectId = props.projectId;
    if (!props.visible || !projectId || pendingSetup) {
      return;
    }
    if (tabs.has(pendingRun)) {
      chooseRun(pendingRun);
    } else if (!pendingRun && runs.loaded()) {
      const id = untrack(selected);
      if (id && (!id.startsWith('app:') || tabs.has(id))) {
        return;
      }
      const first =
        [...tabs.entries()].find(([, run]) => run.state === 'running' || run.state === 'starting') ||
        tabs.entries().next().value;
      if (first) {
        chooseRun(first[0]);
      } else if (id) {
        lastByProject.delete(projectId);
        setSelected('');
      }
    }
  });

  createEffect(() => {
    const id = selected();
    for (const [key, screen] of screens) {
      screen.el.hidden = key !== id;
    }
    frames.schedule(fit);
  });

  onCleanup(() => {
    frames.dispose();
    alive = false;
    confirmationScope.abort();
    for (const screen of screens.values()) {
      disposeTerminalScreen(screen);
    }
    screens.clear();
    client.close();
  });

  const sessionChoices = createMemo(() => [
    ...[...runs.tabs()].map(([id, run]) => {
      let label = run.name + ' · ' + run.state;
      if (id === 'app:' + run.previewId) {
        label += ' · previous';
      }
      return { id, label, disabled: false };
    }),
    ...scope().map((session) => {
      let label = session.title;
      if (session.occupied) {
        label += ' · in use';
      } else if (session.exited) {
        label += ' · exited';
      }
      return { id: session.id, label, disabled: session.occupied };
    }),
  ]);
  const chooseSession = (id: string) => {
    pendingSetup = undefined;
    if (runs.tabs().has(id)) {
      chooseRun(id);
      return;
    }
    const session = scope().find((entry) => entry.id === id && !entry.occupied);
    if (session) {
      void attach(session).catch(fail);
    }
  };
  const controlApp = async (
    run: AppRunSession,
    operation: 'open' | 'restart' | 'stop',
    button: HTMLButtonElement,
  ) => {
    const scope = captureScope();
    const opensPreview = operation === 'restart' && run.state !== 'running';
    let restoreFocus = document.activeElement === button;
    const cancelRestore = () => {
      restoreFocus = false;
    };
    const focusChanged = (event: FocusEvent) => {
      if (event.target !== button && event.target !== document.body) {
        cancelRestore();
      }
    };
    const options = { capture: true, signal: scope.signal };
    document.addEventListener('pointerdown', cancelRestore, options);
    document.addEventListener('keydown', cancelRestore, options);
    document.addEventListener('focusin', focusChanged, options);
    try {
      await runs.control(run, operation);
    } finally {
      document.removeEventListener('pointerdown', cancelRestore, true);
      document.removeEventListener('keydown', cancelRestore, true);
      document.removeEventListener('focusin', focusChanged, true);
      // Stop/Restart can remove or disable the focused button. Only repair that
      // lost focus; a later user interaction or another session owns its focus.
      // Run again can move Chrome to the preview, so restore focus for the return.
      if (
        restoreFocus &&
        scope.isCurrent() &&
        (document.hasFocus() || opensPreview) &&
        document.activeElement === document.body
      ) {
        const target = sessionPicker?.querySelector('[role="combobox"]:enabled');
        if (target instanceof HTMLElement) {
          target.focus();
        }
      }
    }
  };
  createEffect(() => {
    selected();
    props.projectId;
    setLogsOpen(false);
  });

  return (
    <section
      ref={(element) => {
        root = element;
      }}
      class="terminal-dock"
      classList={{ 'terminal-dock-compact': selected().startsWith('app:') && !logsOpen() }}
      hidden={!props.visible}
      aria-label="Local terminal"
    >
      <div class="terminal-toolbar" role="group" aria-label="Terminal controls">
        <strong class="terminal-heading">
          <Icon name="terminal" />
          <span>Terminal</span>
        </strong>
        <div
          class="terminal-session-picker"
          ref={(element) => {
            sessionPicker = element;
          }}
        >
          <TerminalSessionPicker
            value={selected()}
            choices={sessionChoices()}
            change={chooseSession}
            placeholder={props.projectName || 'Choose a project'}
          />
        </div>
        <Show when={selectedRun()}>
          {(run) => (
            <div class="terminal-run-actions" role="group" aria-label="App controls">
              <Show when={run().state === 'running'}>
                <TooltipButton
                  label="Open app"
                  icon="external"
                  disabled={runs.busy().has(run().previewId)}
                  onClick={(event) => void controlApp(run(), 'open', event.currentTarget)}
                />
                <TooltipButton
                  label="Point to edit"
                  icon="pick"
                  disabled={runs.busy().has(run().previewId)}
                  onClick={() => setPickTarget(run())}
                />
              </Show>
              <Show when={run().state !== 'starting'}>
                <Show
                  when={run().state === 'running'}
                  fallback={
                    <TooltipButton
                      label="Run again"
                      icon="play"
                      disabled={runs.busy().has(run().previewId)}
                      onClick={(event) => void controlApp(run(), 'restart', event.currentTarget)}
                    />
                  }
                >
                  <TooltipButton
                    label="Restart"
                    icon="restart"
                    disabled={runs.busy().has(run().previewId)}
                    onClick={(event) => void controlApp(run(), 'restart', event.currentTarget)}
                  />
                </Show>
              </Show>
              <Show when={run().state === 'starting' || run().state === 'running'}>
                <TooltipButton
                  label="Stop"
                  icon="stop"
                  disabled={runs.busy().has(run().previewId)}
                  onClick={(event) => void controlApp(run(), 'stop', event.currentTarget)}
                />
              </Show>
            </div>
          )}
        </Show>
        <Show when={chosen()}>
          <TooltipButton
            label="Clear shell"
            icon="clear"
            onClick={() => {
              const screen = chosen();
              if (alive && screen && !screen.disposed) {
                screen.term.clear();
                screen.term.focus();
              }
            }}
          />
          <TooltipButton label="Close shell" icon="stop" onClick={() => void end()} />
        </Show>
        <div class="spacer" />
        <TooltipButton
          label="New shell"
          icon="plus"
          disabled={!props.projectId || busy() || !ready()}
          onClick={() => void create()}
        />
        <TooltipButton label="Hide terminal" icon="close" onClick={props.close} />
      </div>
      <Show when={error() || runs.error()}>
        <div class="terminal-error" role="alert">
          {error() || runs.error()}
          <button
            onClick={() => {
              setError('');
              void refresh();
              void runs.refresh();
            }}
          >
            Refresh sessions
          </button>
        </div>
      </Show>
      <div
        ref={panel}
        id={panelId}
        class="terminal-panel"
        role="region"
        aria-label={selectedRun()?.name || 'Terminal output'}
        tabIndex={-1}
      >
        <div
          class="terminal-viewport"
          hidden={selected().startsWith('app:')}
          ref={(element) => {
            area = element;
          }}
        />
        <Show when={selectedRun()}>
          {(run) => (
            <AppRunOutput run={run()} preferences={prefs()} expanded={logsOpen()} setExpanded={setLogsOpen} />
          )}
        </Show>
        <Show when={selected().startsWith('app:') && !selectedRun()}>
          <Show
            when={launchFailure()}
            fallback={
              <p class="terminal-run-wait" role="status">
                Starting app…
              </p>
            }
          >
            {(message) => (
              <p class="terminal-run-wait" role="alert">
                {message()}
              </p>
            )}
          </Show>
        </Show>
        <Show when={!selected()}>
          <div class="terminal-empty">
            <strong>No sessions yet</strong>
            <p>Run an app or open a shell.</p>
            <button
              disabled={!props.projectId || busy() || !ready()}
              onClick={() => void create()}
              class="primary"
            >
              Open terminal
            </button>
          </div>
        </Show>
      </div>
      <Show when={pickTarget()} keyed>
        {(target) => (
          <ElementPicker
            run={target}
            rpc={props.rpc}
            close={() => setPickTarget(undefined)}
            picked={(selection) => {
              setPickTarget(undefined);
              props.editElements(target.projectId, selection);
            }}
          />
        )}
      </Show>
    </section>
  );
}
