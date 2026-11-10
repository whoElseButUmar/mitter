import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Action, Envelope, Project, Worker } from '../../../../packages/protocol/src/index.js';
import { isReadReference, type ProposalEnvelope } from '../../../../packages/protocol/src/proposal.js';
import { ReplyValidationError } from '../../../../packages/protocol/src/validation.js';
import { Store } from './database.js';
import { fileText, validateRelative } from './workspace.js';
import { redact } from './redaction.js';
import { sha256Schema } from './storage-schemas.js';
const rangeSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .describe('An inspected UTF-16 source interval.');

export const readVersionSchema = z
  .object({
    base: z.string().refine(isReadReference).describe('The host-issued immutable read reference.'),
    path: z.string().describe('The project-relative file path, confined before use.'),
    hash: sha256Schema.describe('The digest of the complete unredacted source.'),
    characters: z
      .number()
      .int()
      .min(0)
      .max(120000)
      .describe('The visible source length in UTF-16 code units.'),
    redacted: z.boolean().describe('Whether any credential-like source text was masked.'),
    ranges: z
      .array(rangeSchema)
      .max(128)
      .describe('At most 128 inspected source intervals, in UTF-16 code units.'),
  })
  .refine((record) => record.ranges.every((range) => range[1] >= range[0] && range[1] <= record.characters))
  .describe('A body-free immutable file read and the ranges actually delivered.');
type ReadVersion = z.infer<typeof readVersionSchema>;

export const readLedgerSchema = z
  .object({
    version: z.literal(1).describe('The immutable-read ledger format version.'),
    workerId: z.string().describe('The task that owns these reads.'),
    projectId: z.string().describe('The registered project that owns the task.'),
    runId: z.string().describe('The exact run in which these reads were delivered.'),
    epoch: z
      .number()
      .int()
      .nonnegative()
      .describe('The nonnegative control epoch in which these reads were delivered.'),
    root: z.string().describe('The canonical workspace root used for the reads.'),
    reads: z.array(readVersionSchema).max(128).describe('At most 128 body-free immutable read records.'),
  })
  .refine((ledger) => new Set(ledger.reads.map((record) => record.base)).size === ledger.reads.length)
  .describe('A persisted read ledger bound to task, run, epoch and canonical workspace.');
type Ledger = z.infer<typeof readLedgerSchema>;

export const readPageSchema = z
  .object({
    hash: readVersionSchema.shape.hash,
    base: readVersionSchema.shape.base,
    offset: z.number().int().nonnegative().describe('The page start offset in UTF-16 code units.'),
    end: z.number().int().nonnegative().describe('The exclusive page end offset in UTF-16 code units.'),
    totalCharacters: z
      .number()
      .int()
      .nonnegative()
      .describe('The complete visible source length in UTF-16 code units.'),
    complete: z
      .boolean()
      .describe('Whether this page contains the complete visible source from offset zero.'),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('The next UTF-16 page offset, absent on the final page.'),
    redacted: z.literal(true).optional().describe('Present only when credential-like source was masked.'),
    warning: z.string().optional().describe('Why redacted source cannot authorize a full-file rewrite.'),
    content: z.string().describe('The literal visible page text, without truncating a Unicode character.'),
  })
  .describe('A bounded redacted source page referencing an immutable read.');

export const readResultSchema = readPageSchema
  .extend({
    readComplete: z
      .boolean()
      .describe('Whether all ranges of this immutable read have been delivered without redaction.'),
  })
  .describe('A model-visible source read result with cumulative unredacted coverage.');
export type ReadResult = z.infer<typeof readResultSchema>;

const key = (workerId: string) => 'miter.readSnapshots.v1.' + workerId;

function covers(ranges: [number, number][], length: number): boolean {
  const first = ranges[0];

  return ranges.length === 1 && first !== undefined && first[0] === 0 && first[1] === length;
}

function merge(ranges: [number, number][], start: number, end: number): [number, number][] {
  const next: [number, number] = [start, end];
  const sorted = [...ranges, next].sort((first, second) => first[0] - second[0]);
  const output: [number, number][] = [];

  for (const range of sorted) {
    const previous = output.at(-1);

    if (previous && previous[1] >= range[0]) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      output.push([range[0], range[1]]);
    }
  }

  return output;
}

function safeBoundary(text: string, offset: number): number {
  if (
    offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/.test(text.charAt(offset - 1)) &&
    /[\uDC00-\uDFFF]/.test(text.charAt(offset))
  ) {
    return offset - 1;
  }

  return offset;
}

/** References identify immutable reads, never the current file. Resolving a base
 * cannot read/rebase disk; the existing lock/hash/journal preflight still applies. */

export class ReadSnapshots {
  constructor(private store: Store) {}

  private ledger(worker: Worker, project: Project): Ledger {
    const raw = this.store.get(key(worker.id));
    const empty: Ledger = {
      version: 1,
      workerId: worker.id,
      projectId: worker.projectId,
      runId: worker.runId,
      epoch: worker.control?.epoch ?? 0,
      root: project.root,
      reads: [],
    };

    if (raw === undefined) {
      return empty;
    }

    const parsed = readLedgerSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error('File read records are not valid. No file versions were inferred.', {
        cause: parsed.error,
      });
    }

    const ledger = parsed.data;

    if (
      ledger.workerId !== worker.id ||
      ledger.projectId !== worker.projectId ||
      ledger.runId !== worker.runId ||
      ledger.epoch !== (worker.control?.epoch ?? 0) ||
      ledger.root !== project.root
    ) {
      return empty;
    }

    for (const record of ledger.reads) {
      validateRelative(record.path);
    }

    return ledger;
  }

  async read(
    worker: Worker,
    project: Project,
    action: Extract<
      Action,
      {
        type: 'read';
      }
    >,
    signal: AbortSignal,
  ): Promise<ReadResult> {
    validateRelative(action.path);
    const epoch = worker.control?.epoch ?? 0;
    const runId = worker.runId;
    const file = await fileText(project.root, action.path);
    const visible = redact(file.content);
    const redacted = visible !== file.content;
    signal.throwIfAborted();

    if ((worker.control?.epoch ?? 0) !== epoch || worker.runId !== runId) {
      throw new Error('This read belongs to a superseded task run.');
    }

    const offset = action.offset ?? 0;

    if (offset > visible.length || safeBoundary(visible, offset) !== offset) {
      throw new Error(
        'Read offset is outside this file or splits a Unicode character. Read ' + 'from offset 0 again.',
      );
    }

    const ledger = this.ledger(worker, project);
    let record = ledger.reads.find(
      (read) =>
        read.path === action.path &&
        read.hash === file.hash &&
        read.redacted === redacted &&
        read.characters === visible.length,
    );

    if (!record) {
      let base: string;
      do {
        base = 'r_' + randomBytes(8).toString('hex');
      } while (ledger.reads.some((read) => read.base === base));
      record = {
        base,
        path: action.path,
        hash: file.hash,
        characters: visible.length,
        redacted,
        ranges: [],
      };
      ledger.reads.push(record);
    }

    const readRecord: ReadVersion = record;
    let defaultLimit = 32000;
    let maximumLimit = 64000;
    let budget = 47000;

    if (worker.mode === 'local') {
      defaultLimit = 6000;
      maximumLimit = 6000;
      budget = 16000;
    }

    const limit = Math.min(action.limit ?? defaultLimit, maximumLimit);
    let end = safeBoundary(visible, Math.min(visible.length, offset + limit));

    // Include a surrogate pair atomically even when a one-unit limit would split it.

    if (end === offset && offset < visible.length) {
      end = Math.min(visible.length, offset + 2);
    }

    const page = (): z.infer<typeof readPageSchema> => {
      const result: z.infer<typeof readPageSchema> = {
        hash: file.hash,
        base: readRecord.base,
        offset,
        end,
        totalCharacters: visible.length,
        complete: offset === 0 && end === visible.length,
        content: visible.slice(offset, end),
      };

      if (end < visible.length) {
        result.nextOffset = end;
      }

      if (redacted) {
        result.redacted = true;
        result.warning =
          'Credential-like content was masked. Full-file writes using this base ' +
          'are disabled; exact non-sensitive replacements still require unique ' +
          'matches.';
      }

      return result;
    };

    // Budget serialized pages: escaping consumes space too. No partial JSON is returned.

    while (
      JSON.stringify({
        action,
        result: page(),
      }).length > budget &&
      end > offset
    ) {
      end = safeBoundary(visible, offset + Math.floor((end - offset) * 0.85));
    }

    if (end === offset && offset < visible.length) {
      throw new Error('The requested read cannot fit safely. Use a smaller path or read range.');
    }
    readRecord.ranges = merge(readRecord.ranges, offset, end);

    if (readRecord.ranges.length > 128) {
      throw new Error('Too many disjoint read ranges. Read consecutive pages instead.');
    }

    const result = readResultSchema.parse({
      ...page(),
      readComplete: covers(readRecord.ranges, readRecord.characters) && !redacted,
    });
    ledger.reads = ledger.reads.slice(-128);
    this.store.set(key(worker.id), readLedgerSchema.parse(ledger));

    return result;
  }

  resolve(worker: Worker, project: Project, proposal: ProposalEnvelope): Envelope {
    const ledger = this.ledger(worker, project);
    const actions: Action[] = proposal.actions.map((action, index) => {
      if (!('base' in action)) {
        return action;
      }

      if (action.base === 'missing' && action.type === 'write') {
        return {
          type: action.type,
          path: action.path,
          content: action.content,
          expectedHash: 'missing',
        };
      }

      let record: ReadVersion | undefined;

      if (!['complete', 'cancelled'].includes(worker.state)) {
        record = ledger.reads.find((read) => read.base === action.base && read.path === action.path);
      }

      if (!record) {
        throw new ReplyValidationError({
          stage: 'precondition',
          code: 'BASE_UNAVAILABLE',
          field: 'base',
          actionIndex: index,
          message:
            'This base is not a recorded read of this file in the current task/run. ' +
            'Read the file again. No file was changed.',
        });
      }

      if (action.type === 'write' && (!covers(record.ranges, record.characters) || record.redacted)) {
        throw new ReplyValidationError({
          stage: 'precondition',
          code: 'BASE_INCOMPLETE',
          field: 'base',
          actionIndex: index,
          message:
            'A full-file write needs a complete, unredacted read. Read the ' +
            'remaining pages, or use an exact replacement in the portion already ' +
            'inspected.',
        });
      }

      if (action.type === 'write') {
        return {
          type: action.type,
          path: action.path,
          content: action.content,
          expectedHash: record.hash,
        };
      }

      return {
        type: action.type,
        path: action.path,
        before: action.before,
        after: action.after,
        expectedHash: record.hash,
      };
    });

    return {
      ...proposal,
      actions,
    };
  }
}
