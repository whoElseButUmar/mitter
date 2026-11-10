import { enhanceSelect } from './select.js';
import { textElement } from './dom/elements.js';
import type { ChangeReview } from './forms/report-schemas.js';
import { callCoreRpc } from './rpc.js';

export type ChangeReviewOptions = {
  workerId: string;
  path?: string;
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  notice: (text: string) => void;
};

export function mountChangeReview(root: HTMLElement, options: ChangeReviewOptions) {
  root.classList.add('miter-release-tool');
  const document = root.ownerDocument;
  let disposed = false;
  let generation = 0;
  let review: ChangeReview | undefined;
  let busy = false;
  let selectControl: ReturnType<typeof enhanceSelect> | undefined;
  const make = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag, text = '', className = '') =>
    textElement(document, tag, text, className);
  const label = make('label', 'File', 'field');
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'File to review');
  label.append(select);
  const status = make('p', 'Loading changes…', 'change-status');
  status.setAttribute('role', 'status');
  const hint = make(
    'p',
    'Recorded changes for this task’s current run. ' + 'Reviewing does not apply or re-run anything.',
    'preview-hint',
  );
  const output = make('div', '', 'change-diff');
  output.tabIndex = 0;
  output.setAttribute('aria-label', 'Recorded file changes');
  const actions = make('div', '', 'button-row');
  const reload = make('button', 'Reload');
  const restore = make('button', 'Restore this file…');
  reload.type = 'button';
  restore.type = 'button';
  actions.append(reload, restore);
  const error = make('p', '', 'error');
  error.setAttribute('role', 'alert');
  const confirmation = make('div', '', 'restore-confirmation');
  confirmation.hidden = true;
  const warning = make(
    'p',
    'Restore this file to its content before this run? A created file will be removed. ' +
      'Other files and command side effects are not changed.',
  );
  const cancel = make('button', 'Keep file');
  const confirm = make('button', 'Restore file');
  cancel.type = 'button';
  confirm.type = 'button';
  confirmation.append(warning, cancel, confirm);
  root.append(label, hint, status, output, error, actions, confirmation);

  function pending(value: boolean): void {
    busy = value;
    select.disabled = value;
    selectControl?.refresh();
    reload.disabled = value;
    restore.disabled = value || !review?.canRestore;
    confirm.disabled = value;
  }

  async function load(): Promise<void> {
    generation += 1;
    const id = generation;
    pending(true);
    error.textContent = '';
    confirmation.hidden = true;
    review = undefined;
    restore.disabled = true;
    output.replaceChildren();

    try {
      const response = await callCoreRpc(options.rpc, 'worker.change', {
        workerId: options.workerId,
        path: select.value,
      });

      if (disposed || id !== generation) {
        return;
      }

      const value = response;
      review = value;
      status.textContent =
        value.path + ' · ' + value.kind + ' · +' + value.diff.additions + ' / −' + value.diff.deletions;

      if (value.conflict) {
        status.textContent += ' · Modified since this run';
      }

      if (value.warning) {
        error.textContent = value.warning;
      }

      for (const line of value.diff.lines) {
        let number = String(line.newLine ?? line.oldLine ?? '');
        let prefix = '  ';

        if (line.kind === 'omitted') {
          number = '…';
          prefix = '… ';
        } else if (line.kind === 'add') {
          prefix = '+ ';
        } else if (line.kind === 'remove') {
          prefix = '− ';
        }

        const row = make('div', '', 'diff-line diff-' + line.kind);
        row.append(make('span', number, 'diff-number'), make('code', prefix + line.text));
        output.append(row);
      }

      if (!value.diff.lines.length) {
        output.append(make('p', 'No text difference in the recorded versions.', 'preview-hint'));
      }

      if (value.diff.truncated || value.diff.simplified) {
        output.append(
          make(
            'p',
            'Large change: this is a bounded review, not a patch for applying. ' +
              'Open the file in your editor for the full source.',
            'preview-hint',
          ),
        );
      }
    } catch (reason) {
      if (!disposed && id === generation) {
        error.textContent = String(reason);

        if (reason instanceof Error) {
          error.textContent = reason.message;
        }
      }
    } finally {
      if (!disposed && id === generation) {
        pending(false);
      }
    }
  }

  select.onchange = () => {
    if (!busy) {
      void load();
    }
  };
  reload.onclick = () => void load();
  restore.onclick = () => {
    if (!review || busy) {
      return;
    }

    confirmation.hidden = false;
    cancel.focus();
  };
  cancel.onclick = () => {
    confirmation.hidden = true;
    restore.focus();
  };
  confirm.onclick = () => {
    if (!review || busy) {
      return;
    }

    pending(true);
    const saved = review;
    void callCoreRpc(options.rpc, 'worker.restoreFile', {
      workerId: options.workerId,
      path: saved.path,
      expectedHash: saved.currentHash,
      confirm: true,
    })
      .then(() => {
        if (!disposed) {
          options.notice('Restored ' + saved.path + '. Other files were preserved.');
          status.textContent = 'Recorded edits restored for ' + saved.path;
          output.replaceChildren();
          review = undefined;
          confirmation.hidden = true;
        }
      })
      .catch((reason) => {
        if (!disposed) {
          error.textContent = String(reason);

          if (reason instanceof Error) {
            error.textContent = reason.message;
          }
        }
      })
      .finally(() => {
        if (!disposed) {
          pending(false);
        }
      });
  };

  pending(true);
  void callCoreRpc(options.rpc, 'worker.files', { workerId: options.workerId })
    .then((files) => {
      if (disposed) {
        return;
      }

      for (const file of files.filter((file) => ['applied', 'prepared'].includes(file.status))) {
        const option = document.createElement('option');
        option.value = file.path;
        option.textContent = file.path;
        select.append(option);
      }

      if (options.path && Array.from(select.options).some((option) => option.value === options.path)) {
        select.value = options.path;
      }

      if (!select.options.length) {
        status.textContent = 'No active journaled file changes in this run.';
        pending(false);
        restore.disabled = true;
        reload.disabled = true;
        return;
      }

      selectControl = enhanceSelect(select);
      return load();
    })
    .catch((reason) => {
      if (!disposed) {
        error.textContent = String(reason);

        if (reason instanceof Error) {
          error.textContent = reason.message;
        }

        pending(false);
      }
    });

  return {
    dispose() {
      disposed = true;
      generation += 1;
      selectControl?.dispose();
      select.onchange = null;
      reload.onclick = null;
      restore.onclick = null;
      cancel.onclick = null;
      confirm.onclick = null;
      root.replaceChildren();
      root.classList.remove('miter-release-tool');
    },
  };
}
