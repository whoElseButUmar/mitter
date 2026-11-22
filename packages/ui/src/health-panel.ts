import { describeBuild } from '../../protocol/src/index.js';
import { textElement } from './dom/elements.js';
import type { HealthReport } from './forms/report-schemas.js';
import { callCoreRpc } from './rpc.js';

export type HealthPanelOptions = {
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  copy: (text: string) => Promise<unknown>;
  notice: (text: string) => void;
};

/** Mounted only on demand. No periodic health polling or hidden network calls. */
export function mountHealthPanel(root: HTMLElement, options: HealthPanelOptions) {
  root.classList.add('miter-release-tool');
  const document = root.ownerDocument;
  let disposed = false;
  let busy = false;
  let generation = 0;
  let report: HealthReport | undefined;
  const make = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag, text = '', className = '') =>
    textElement(document, tag, text, className);
  const state = make('p', 'Checking the local host…', 'health-status');
  state.setAttribute('role', 'status');
  const detail = make('dl', '', 'health-details');
  const attention = make('div');
  const actions = make('div', '', 'button-row');
  const backups = make('div', '', 'backup-list');
  const error = make('p', '', 'error');
  error.setAttribute('role', 'alert');
  const refresh = make('button', 'Check again');
  const backup = make('button', 'Back up task state');
  const copy = make('button', 'Copy health report');

  for (const button of [refresh, backup, copy]) {
    button.type = 'button';
  }

  actions.append(refresh, backup, copy);
  const note = make(
    'p',
    'State backups include task history and journaled source, ' +
      'not project folders or worktree files. Keep them private.',
    'preview-hint',
  );
  root.append(state, detail, attention, actions, error, make('h3', 'Recent state backups'), backups, note);

  function pending(value: boolean): void {
    busy = value;
    refresh.disabled = value;
    backup.disabled = value;
    copy.disabled = value || !report;
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy || disposed) {
      return;
    }

    pending(true);
    error.textContent = '';

    try {
      await action();
    } catch (reason) {
      if (!disposed) {
        error.textContent = String(reason);

        if (reason instanceof Error) {
          error.textContent = reason.message;
        }
      }
    } finally {
      if (!disposed) {
        pending(false);
      }
    }
  }

  async function load(): Promise<void> {
    generation += 1;
    const id = generation;
    const response = await callCoreRpc(options.rpc, 'system.health');

    if (disposed || id !== generation) {
      return;
    }

    const next = response;
    report = next;
    detail.replaceChildren();
    attention.replaceChildren();
    backups.replaceChildren();
    state.textContent = 'Local host connected · Database needs attention';

    if (next.database.ok) {
      state.textContent = 'Local host connected · Database check passed';
    }

    for (const [label, value] of [
      ['Helper build', describeBuild(next.version, next.buildId)],
      ['Runtime', next.node + ' · ' + next.workflow],
      ['Tasks', next.tasks.total + ' saved · ' + next.tasks.active + ' executing locally'],
      ['State directory', next.dataDirectory],
    ]) {
      detail.append(make('dt', String(label)), make('dd', String(value)));
    }

    if (next.attention.length) {
      attention.append(
        make(
          'p',
          next.attention.length + ' task(s) need attention. Open their task tabs for recovery or approvals.',
          'muted',
        ),
      );
    }

    if (!next.backups.length) {
      backups.append(
        make(
          'p',
          'No state backup yet. An existing database is backed up before ' +
            'the first launch of a different release.',
          'muted',
        ),
      );
    }

    for (const item of next.backups) {
      const row = make('div', '', 'backup-row');
      const name = make('div', new Date(item.createdAt).toLocaleString() + ' · ' + item.reason);
      const metadata = make('small', Math.ceil(item.bytes / 1024) + ' KB · ' + item.appVersion, 'muted');
      const buttons = make('div', '', 'button-row');
      const verify = make('button', 'Verify');
      const command = make('button', 'Copy restore command');
      verify.type = 'button';
      command.type = 'button';
      verify.onclick = () =>
        void run(async () => {
          await callCoreRpc(options.rpc, 'system.verifyBackup', { id: item.id });

          if (!disposed) {
            options.notice('Backup checksum and database verified.');
          }
        });
      command.onclick = () =>
        void run(async () => {
          await options.copy('node scripts/maintenance.mjs restore ' + item.id + ' --confirm');
        });
      buttons.append(verify, command);
      row.append(name, metadata, buttons);
      backups.append(row);
    }
  }

  refresh.onclick = () => void run(load);
  backup.onclick = () =>
    void run(async () => {
      await callCoreRpc(options.rpc, 'system.backup');

      if (!disposed) {
        options.notice('Task-state backup created. Project files are not included.');
        await load();
      }
    });
  copy.onclick = () =>
    void run(async () => {
      await options.copy(JSON.stringify(report, null, 2));
    });
  const help = make('details');
  const summary = make('summary', 'Restore and safety');
  help.append(
    summary,
    make(
      'p',
      'To restore: close or disable Miter first, then run the copied command ' +
        'from the installed mitter folder. A backup of the current state is made before replacement. ' +
        'Restoring state does not roll back project files. ' +
        'Approved commands run with your operating-system ' +
        'permissions, not in an OS sandbox.',
      'preview-hint',
    ),
  );
  root.append(help);
  void run(load);

  return {
    dispose() {
      disposed = true;
      generation += 1;
      refresh.onclick = null;
      backup.onclick = null;
      copy.onclick = null;
      root.replaceChildren();
      root.classList.remove('miter-release-tool');
    },
  };
}
