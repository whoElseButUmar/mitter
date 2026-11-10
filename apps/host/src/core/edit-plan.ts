import { createHash } from 'node:crypto';
import { skippedEditSchema, fileHashSchema } from './storage-schemas.js';
import { z } from 'zod';
import type { Action, Envelope } from '../../../../packages/protocol/src/index.js';
import { MAX_TEXT } from '../../../../packages/protocol/src/index.js';
import type { Store, Journal } from './database.js';

export type FileEdit = Extract<
  Action,
  {
    type: 'write' | 'replace';
  }
>;

export const fileVersionSchema = z
  .object({
    content: z.string().nullable().describe('The exact source text, or null for an absent file.'),
    hash: fileHashSchema.describe('The digest of the exact source text, or missing for an absent file.'),
  })
  .describe('Exact file content and its hash, or a missing-file version.');

export type FileVersion = z.infer<typeof fileVersionSchema>;

export type EditStep = {
  index: number;
  id: string;
  action: FileEdit;
  before: FileVersion;
  after: FileVersion;
  prior: Journal | undefined;
  done: boolean;
};

export type EditPlan = {
  start: number;
  end: number;
  steps: EditStep[];
};

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export const isFileEdit = (action: Action): action is FileEdit =>
  action.type === 'write' || action.type === 'replace';

/** Expected conflicts are data for replanning, NOT permission to ignore a hash. */

export class EditConflict extends Error {
  constructor(
    readonly code: 'STALE_EDIT' | 'REPLACE_MATCH' | 'EDIT_OUTPUT',
    readonly path: string,
    message: string,
    readonly index = -1,
    readonly expectedHash?: string,
    readonly currentHash?: string,
  ) {
    super(message);
    this.name = 'EditConflict';
  }
}

export function staleEdit(path: string, expected: string, actual: string, index = -1): EditConflict {
  return new EditConflict(
    'STALE_EDIT',
    path,
    `Stale edit for ${path}. Read it again. Current SHA-256: ${actual}`,
    index,
    expected,
    actual,
  );
}

/** Pure transform: replacement is literal (including $&, backticks, CRLF and BOM). */

export function editContent(action: FileEdit, before: FileVersion, index = -1): FileVersion {
  let content: string;

  if (action.type === 'replace') {
    if (before.content === null) {
      throw new EditConflict('REPLACE_MATCH', action.path, 'Cannot replace text in a missing file.', index);
    }

    if (!action.before) {
      throw new EditConflict('REPLACE_MATCH', action.path, 'Replacement text must not be empty.', index);
    }

    const first = before.content.indexOf(action.before);
    // Count overlapping occurrences too. split() incorrectly treats "aa" in
    // "aaa" as unique, although there are two valid insertion locations.

    if (first < 0 || before.content.indexOf(action.before, first + 1) >= 0) {
      throw new EditConflict(
        'REPLACE_MATCH',
        action.path,
        `Replacement must match exactly once; ${matchDescription(first)}.`,
        index,
      );
    }
    content =
      before.content.slice(0, first) + action.after + before.content.slice(first + action.before.length);
  } else {
    content = action.content;
  }

  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT) {
    throw new EditConflict('EDIT_OUTPUT', action.path, 'Write exceeds 120 KB.', index);
  }

  if (content.includes('\0') || Buffer.from(content, 'utf8').toString('utf8') !== content) {
    throw new EditConflict(
      'EDIT_OUTPUT',
      action.path,
      'Write must be well-formed UTF-8 text without NUL bytes.',
      index,
    );
  }

  return {
    content,
    hash: digest(content),
  };
}

function matchDescription(first: number): string {
  if (first < 0) {
    return 'found 0 matches';
  }

  return 'found multiple matches';
}

function validVersion(version: FileVersion): boolean {
  if (version.content === null) {
    return version.hash === 'missing';
  }

  return version.hash === digest(version.content);
}

function historyError(path: string): Error {
  // A journal mismatch is not a routine stale edit: don't discard its evidence
  // or replan automatically when the host cannot establish what actually ran.

  return new Error(
    `Edit history for ${path} is ambiguous. Files were preserved; inspect the journal before continuing.`,
  );
}

function checkJournal(j: Journal, step: EditStep, workerId: string, runId: string): void {
  if (
    j.id !== step.id ||
    j.workerId !== workerId ||
    j.runId !== runId ||
    j.path !== step.action.path ||
    !['applied', 'prepared'].includes(j.status) ||
    j.before !== step.before.content ||
    j.beforeHash !== step.before.hash ||
    j.after !== step.after.content ||
    j.afterHash !== step.after.hash
  ) {
    throw historyError(step.action.path);
  }
}

/** Plan a contiguous write/replace segment under the caller's project lock.
 * No filesystem writes or journal mutations occur here. The original envelope
 * and action IDs are never rewritten. Prior actions are trusted ONLY through
 * this exact batch's verified journal, including when resuming an older host.
 * A command/read/ask/finish is a boundary: no hash rebasing crosses it.
 */

export async function planEdits(
  store: Store,
  workerId: string,
  runId: string,
  batch: Envelope,
  cursor: number,
  read: (path: string) => Promise<FileVersion>,
): Promise<EditPlan> {
  if (
    !Number.isInteger(cursor) ||
    cursor < 0 ||
    cursor >= batch.actions.length ||
    !batch.actions[cursor] ||
    !isFileEdit(batch.actions[cursor])
  ) {
    throw new Error('Expected a file-edit cursor.');
  }

  if (batch.workerId !== workerId) {
    throw new Error('Edit batch belongs to another worker.');
  }

  let start = cursor;
  let end = cursor + 1;

  while (start > 0) {
    const previous = batch.actions[start - 1];

    if (!previous || !isFileEdit(previous)) {
      break;
    }
    start--;
  }

  while (end < batch.actions.length) {
    const next = batch.actions[end];

    if (!next || !isFileEdit(next)) {
      break;
    }
    end++;
  }

  const byPath = new Map<
    string,
    {
      index: number;
      action: FileEdit;
    }[]
  >();

  for (let index = start; index < end; index++) {
    const action = batch.actions[index];

    if (!action || !isFileEdit(action)) {
      throw new Error('Expected a file-edit action.');
    }

    const actionId = `${batch.id}_${index}`;
    const skipped = store.get(`edit-skipped:${actionId}`, skippedEditSchema);

    if (
      index < cursor &&
      skipped &&
      skipped.workerId === workerId &&
      skipped.runId === runId &&
      skipped.actionHash === digest(JSON.stringify(action)) &&
      !store.journal(actionId)
    ) {
      continue;
    }

    const list = byPath.get(action.path) ?? [];
    list.push({
      index,
      action,
    });
    byPath.set(action.path, list);
  }

  const steps: EditStep[] = [];

  for (const [path, entries] of byPath) {
    const live = await read(path);
    const first = entries[0];

    if (!first) {
      throw historyError(path);
    }

    const firstJournal = store.journal(`${batch.id}_${first.index}`);
    let version = live;

    if (firstJournal) {
      version = {
        content: firstJournal.before,
        hash: firstJournal.beforeHash,
      };
    }

    if (!validVersion(version)) {
      throw historyError(path);
    }

    const anchors = new Set([version.hash]);
    const fileSteps: EditStep[] = [];
    let hole = false;
    let prepared = false;

    for (const { index, action } of entries) {
      const id = `${batch.id}_${index}`;
      const prior = store.journal(id);
      const skipped = store.get(`edit-skipped:${id}`, skippedEditSchema);

      if (
        skipped &&
        index < cursor &&
        !prior &&
        skipped.workerId === workerId &&
        skipped.runId === runId &&
        skipped.actionHash === digest(JSON.stringify(action))
      ) {
        continue;
      }
      // A complete write must always name the immediate input version. Only
      // exact-snippet replacements can reuse an earlier hash in this segment.

      if (
        action.expectedHash !== version.hash &&
        !(action.type === 'replace' && anchors.has(action.expectedHash))
      ) {
        throw staleEdit(path, action.expectedHash, version.hash, index);
      }

      let after: FileVersion;

      try {
        after = editContent(action, version, index);
      } catch (error) {
        if (prior) {
          throw historyError(path);
        }

        throw error;
      }

      const step: EditStep = {
        index,
        id,
        action,
        before: version,
        after,
        prior,
        done: false,
      };

      if (prior) {
        if (hole || prepared) {
          throw historyError(path);
        }
        checkJournal(prior, step, workerId, runId);
        prepared = prior.status === 'prepared';
        step.done = prior.status === 'applied';
      } else {
        if (index < cursor) {
          throw historyError(path);
        }
        hole = true;
      }
      fileSteps.push(step);
      version = step.after;
      anchors.add(version.hash);
    }

    const lastJournal = [...fileSteps].reverse().find((step) => step.prior);

    if (lastJournal?.prior) {
      if (lastJournal.prior.status === 'prepared') {
        if (live.hash === lastJournal.after.hash) {
          lastJournal.done = true;
        } else if (live.hash !== lastJournal.before.hash) {
          throw staleEdit(path, lastJournal.after.hash, live.hash, lastJournal.index);
        }

        if (lastJournal.index < cursor && !lastJournal.done) {
          throw historyError(path);
        }
      } else if (live.hash !== lastJournal.after.hash) {
        throw staleEdit(path, lastJournal.after.hash, live.hash, lastJournal.index);
      }
    }
    // With no journal, live was the base used by the complete simulation above.
    steps.push(...fileSteps.filter((step) => step.index >= cursor));
  }
  steps.sort((a, b) => a.index - b.index);

  return {
    start,
    end,
    steps,
  };
}
