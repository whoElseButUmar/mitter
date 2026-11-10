/** Bounded line diff for display only. Never used to apply or reconstruct code. */
import { requireItem } from './dom/elements.js';
import type { DiffLine, LineDiff } from '../../protocol/src/rpc.js';

export {
  diffLineSchema as DiffLineSchema,
  lineDiffSchema as LineDiffSchema,
  type DiffLine,
  type LineDiff,
} from '../../protocol/src/rpc.js';

function splitLines(text: string): string[] {
  if (text === '') {
    return [];
  }

  return text.replace(/\n$/, '').split('\n');
}

export function lineDiff(before: string, after: string): LineDiff {
  if (before === after) {
    return {
      lines: [],
      additions: 0,
      deletions: 0,
      truncated: false,
      simplified: false,
    };
  }

  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  let suffix = 0;

  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const left = oldLines.slice(prefix, oldLines.length - suffix);
  const right = newLines.slice(prefix, newLines.length - suffix);
  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let characters = 0;
  let truncated = false;

  function add(line: DiffLine): void {
    if (lines.length >= 800 || characters >= 80000) {
      truncated = true;
      return;
    }

    let display = line.text;

    if (display.endsWith('\n')) {
      display = display.slice(0, -1);
    }

    const text = display.slice(0, Math.max(0, Math.min(4000, 80000 - characters)));

    if (text.length !== display.length) {
      truncated = true;
    }

    characters += text.length;
    lines.push({ ...line, text });
  }

  if (prefix > 3) {
    add({ kind: 'omitted', text: `${prefix - 3} unchanged lines` });
  }

  for (let index = Math.max(0, prefix - 3); index < prefix; index += 1) {
    add({
      kind: 'same',
      text: requireItem(oldLines, index),
      oldLine: index + 1,
      newLine: index + 1,
    });
  }

  const simplified = left.length * right.length > 250000;

  if (simplified) {
    for (const [index, text] of left.entries()) {
      deletions += 1;
      add({ kind: 'remove', text, oldLine: prefix + index + 1 });
    }

    for (const [index, text] of right.entries()) {
      additions += 1;
      add({ kind: 'add', text, newLine: prefix + index + 1 });
    }
  } else {
    const width = right.length + 1;
    const table = new Uint32Array((left.length + 1) * width);

    for (let oldIndex = left.length - 1; oldIndex >= 0; oldIndex -= 1) {
      for (let newIndex = right.length - 1; newIndex >= 0; newIndex -= 1) {
        let length = Math.max(
          requireItem(table, (oldIndex + 1) * width + newIndex),
          requireItem(table, oldIndex * width + newIndex + 1),
        );

        if (left[oldIndex] === right[newIndex]) {
          length = requireItem(table, (oldIndex + 1) * width + newIndex + 1) + 1;
        }

        table[oldIndex * width + newIndex] = length;
      }
    }

    let oldIndex = 0;
    let newIndex = 0;

    while (oldIndex < left.length || newIndex < right.length) {
      if (oldIndex < left.length && newIndex < right.length && left[oldIndex] === right[newIndex]) {
        add({
          kind: 'same',
          text: requireItem(left, oldIndex),
          oldLine: prefix + oldIndex + 1,
          newLine: prefix + newIndex + 1,
        });
        oldIndex += 1;
        newIndex += 1;
      } else if (
        newIndex < right.length &&
        (oldIndex === left.length ||
          requireItem(table, oldIndex * width + newIndex + 1) >
            requireItem(table, (oldIndex + 1) * width + newIndex))
      ) {
        additions += 1;
        add({
          kind: 'add',
          text: requireItem(right, newIndex),
          newLine: prefix + newIndex + 1,
        });
        newIndex += 1;
      } else {
        deletions += 1;
        add({
          kind: 'remove',
          text: requireItem(left, oldIndex),
          oldLine: prefix + oldIndex + 1,
        });
        oldIndex += 1;
      }
    }
  }

  for (let index = 0; index < Math.min(3, suffix); index += 1) {
    add({
      kind: 'same',
      text: requireItem(oldLines, oldLines.length - suffix + index),
      oldLine: oldLines.length - suffix + index + 1,
      newLine: newLines.length - suffix + index + 1,
    });
  }

  if (suffix > 3) {
    add({ kind: 'omitted', text: `${suffix - 3} unchanged lines` });
  }

  if (before.endsWith('\n') !== after.endsWith('\n')) {
    let text = 'No final newline in the new version';

    if (after.endsWith('\n')) {
      text = 'Final newline added';
    }

    add({ kind: 'omitted', text });
  }

  return { lines, additions, deletions, truncated, simplified };
}
