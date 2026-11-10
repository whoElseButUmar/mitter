import { errorMessage } from './schemas/primitives';
import { createAnimationFrames } from './ui/animation-frames';
import { bindTerminalInput, readTerminalScreen } from './ui/terminal-session';
import { disposeTerminalScreen, type TerminalScreen as Screen } from './ui/terminal-screen';
import { createTerminalAppearance } from './ui/terminal-appearance';
import { terminalSettings } from './ui/terminal-settings';
import { TerminalAppearance } from './components/TerminalAppearance';
import { requireElement } from './ui/dom';
import { createSignal, createEffect, onMount, onCleanup, For, Show } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalClient } from './terminal-client';
import type { TerminalInfo } from '../../../packages/terminal/src/protocol';
import './terminal.css';

export function TerminalDock(props: {
  visible: boolean;
  projectId: string;
  workerId?: string;
  projectName: string;
  close: () => void;
}) {
  const frames = createAnimationFrames();

  let area: HTMLDivElement | undefined;
  let root: HTMLElement | undefined;
  const [sessions, setSessions] = createSignal<TerminalInfo[]>([]);
  const [selected, setSelected] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [appearance, setAppearance] = createSignal(false);

  const screens = new Map<string, Screen>();

  const lastByProject = new Map<string, string>();

  let alive = true;
  let listBusy = false;
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

  const sessionTitle = (session: TerminalInfo) => {
    if (session.occupied) {
      return 'In use by another view';
    }

    return session.cwd;
  };

  const fail = (error: unknown) => {
    if (alive) {
      setError(errorMessage(error));
    }
  };

  const {
    prefs,
    fonts,
    ready,
    systemFonts,
    fontBusy,
    apply,
    importTheme,
    importFont,
    removeFont,
    useSystemFonts,
  } = createTerminalAppearance(
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
    if (listBusy || !props.projectId) {
      return;
    }
    listBusy = true;
    const projectId = props.projectId;
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
      fail(event);
    } finally {
      listBusy = false;
    }
  }
  const choose = (id: string) => {
    const projectId = screens.get(id)?.info.projectId;
    if (projectId) {
      lastByProject.set(projectId, id);
    }
    if (projectId === props.projectId) {
      setSelected(id);
    }
  };

  async function attach(info: TerminalInfo) {
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
    await client.request('terminal.attach', {
      sessionId: info.id,
    });
    if (!alive) {
      return;
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
          try {
            const linkURL = new URL(uri);
            if (!['https:', 'http:'].includes(linkURL.protocol)) {
              throw Error('Only HTTP(S) terminal links can be opened.');
            }
            if (confirm('Open this terminal link in your browser?\n' + linkURL.href)) {
              void chrome.tabs.create({
                url: linkURL.href,
              });
            }
          } catch (event) {
            fail(event);
          }
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
      isCurrent: () => alive && screens.get(info.id) === screen,
      fail,
    });
    choose(info.id);
    frames.schedule(() => {
      if (!alive || screen.disposed) {
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
  async function create() {
    if (busy() || !props.projectId) {
      return;
    }
    if (
      !confirm(
        'Open a real local shell?\n\nIt has your macOS/user permissions, not just access to this project. Commands you type run directly. Terminal contents are not sent to ChatGPT.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const projectId = props.projectId;
      const workerScope: { workerId?: string } = {};
      if (props.workerId) {
        workerScope.workerId = props.workerId;
      }

      const info = await client.request('terminal.create', {
        projectId,
        ...workerScope,
        cols: 80,
        rows: 18,
        confirm: true,
      });
      await refresh();
      await attach(info);
    } catch (event) {
      fail(event);
    } finally {
      setBusy(false);
    }
  }
  async function end() {
    const screen = chosen();
    if (
      !screen ||
      !confirm('Close this shell and its attached terminal session? Running foreground work may stop.')
    ) {
      return;
    }
    try {
      await client.request('terminal.close', {
        sessionId: screen.info.id,
        confirm: true,
      });
      disposeTerminalScreen(screen);
      screens.delete(screen.info.id);
      setSelected('');
      lastByProject.delete(screen.info.projectId);
      await refresh();
    } catch (event) {
      fail(event);
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
    if (ready() && props.visible && props.projectId) {
      void refresh();
      const id = lastByProject.get(props.projectId) || '';
      setSelected(id);
      frames.schedule(fit);
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
    for (const screen of screens.values()) {
      disposeTerminalScreen(screen);
    }
    screens.clear();
    client.close();
  });

  return (
    <section
      ref={(element) => {
        root = element;
      }}
      class="terminal-dock"
      hidden={!props.visible}
      aria-label="Local terminal"
    >
      <div class="terminal-toolbar">
        <strong>Terminal</strong>
        <small title="Project or task worktree used when the shell starts">
          {props.projectName || 'Choose a project'}
        </small>
        <div class="spacer" />
        <button
          disabled={!props.projectId || busy() || !ready()}
          onClick={() => void create()}
          title="New shell"
        >
          +<span class="wide-label"> New shell</span>
        </button>
        <button onClick={() => setAppearance(true)} title="Themes and fonts">
          Appearance…
        </button>
        <button
          class="icon-button"
          onClick={props.close}
          title="Hide terminal (keep shells running)"
          aria-label="Hide terminal"
        >
          ×
        </button>
      </div>
      <Show when={error()}>
        <div class="terminal-error" role="alert">
          {error()}
          <button
            onClick={() => {
              setError('');
              void refresh();
            }}
          >
            Refresh sessions
          </button>
        </div>
      </Show>
      <div class="terminal-session-row" role="tablist" aria-label="Project terminals">
        <For each={scope()}>
          {(screen) => (
            <button
              role="tab"
              aria-selected={selected() === screen.id}
              disabled={screen.occupied}
              title={sessionTitle(screen)}
              onClick={() => void attach(screen).catch(fail)}
            >
              {screen.title}
              <Show when={screen.exited} fallback={''}>
                {' · exited'}
              </Show>
            </button>
          )}
        </For>
        <Show when={selected()}>
          <div class="spacer" />
          <button
            class="text-button"
            onClick={() => {
              const screen = chosen();
              if (alive && screen && !screen.disposed) {
                screen.term.clear();
                screen.term.focus();
              }
            }}
          >
            Clear
          </button>
          <button class="text-button" onClick={() => void end()}>
            Close shell
          </button>
        </Show>
      </div>
      <div
        class="terminal-viewport"
        ref={(element) => {
          area = element;
        }}
      />
      <Show when={!selected()}>
        <div class="terminal-empty">
          <strong>Open a local shell</strong>
          <p>
            Open a shell in this project. Its input and output stay separate from ChatGPT and task reports.
          </p>
          <button
            disabled={!props.projectId || busy() || !ready()}
            onClick={() => void create()}
            class="primary"
          >
            Open terminal
          </button>
        </div>
      </Show>
      <div class="terminal-status">
        <span>Local shell · user permissions</span>
        <span>Sessions last while the local host is running</span>
      </div>
      <Show when={appearance()}>
        <TerminalAppearance
          prefs={prefs}
          fonts={fonts}
          systemFonts={systemFonts}
          ready={ready}
          fontBusy={fontBusy}
          error={error}
          apply={apply}
          fail={fail}
          importTheme={importTheme}
          importFont={importFont}
          removeFont={removeFont}
          useSystemFonts={useSystemFonts}
          close={() => setAppearance(false)}
        />
      </Show>
    </section>
  );
}
