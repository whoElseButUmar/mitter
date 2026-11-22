import { promises as fs } from 'node:fs';
import type { Action, Project, Envelope } from '../../../../../packages/protocol/src/index.js';
import { Store } from '../database.js';
import { digest, editContent, planEdits, staleEdit } from '../edit-plan.js';
import type { EditStep } from '../edit-plan.js';
import { hasErrorCode } from '../types.js';
import { safePath, existing, atomicWrite, imageFileHash, validateRelative } from './files.js';
import { validateProjectImage } from './image-source.js';
import { optimizeProjectImage, webImagePath } from './image-optimization.js';
import { z } from 'zod';
import { fileHashSchema } from '../storage-schemas.js';

export const workspaceWriteSchema = z
  .object({
    path: z.string().describe('The confined project-relative path of the journaled edit.'),
    hash: fileHashSchema.describe(
      'The resulting file digest established by publication or verified history.',
    ),
    alreadyApplied: z.boolean().optional().describe('Whether the exact journaled edit was already on disk.'),
    recovered: z
      .boolean()
      .optional()
      .describe('Whether an immutable prepared edit was recovered without blind replay.'),
    bytes: z.number().int().nonnegative().optional().describe('Number of bytes published to the file.'),
    originalBytes: z.int().positive().optional().describe('Image size in bytes before optimization.'),
    width: z.int().positive().optional().describe('Saved image width in pixels.'),
    height: z.int().positive().optional().describe('Saved image height in pixels.'),
  })
  .describe('A journaled edit result, including exact-file recovery without replay.');

export type WorkspaceWrite = z.infer<typeof workspaceWriteSchema>;

import type { WorkspaceRollback } from '../../../../../packages/protocol/src/rpc.js';
export { workspaceRollbackSchema } from '../../../../../packages/protocol/src/rpc.js';
export type { WorkspaceRollback } from '../../../../../packages/protocol/src/rpc.js';

export class Workspace {
  constructor(readonly store: Store) {}

  async plan(project: Project, workerId: string, runId: string, batch: Envelope, cursor: number) {
    if (batch.projectId !== project.id) {
      throw new Error('Edit batch belongs to another project.');
    }
    // Different spellings of the same existing path (notably on macOS) must
    // not be planned as independent files. No symlink traversal is introduced.
    const names = new Map<string, string>();

    return planEdits(this.store, workerId, runId, batch, cursor, async (relative) => {
      const target = await safePath(project.root, relative);

      try {
        const real = await fs.realpath(target);
        const prior = names.get(real);

        if (prior && prior !== relative) {
          throw new Error(`Use one spelling for the same file: ${prior} and ${relative}.`);
        }
        names.set(real, relative);
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
          throw error;
        }
      }

      return existing(project.root, relative);
    });
  }

  async commitStep(
    project: Project,
    workerId: string,
    runId: string,
    step: EditStep,
  ): Promise<WorkspaceWrite> {
    if (step.done) {
      // The whole journal chain and its current disk head were proved by plan().
      // A cursor lag after a crash must never replay a superseded earlier write.

      if (step.prior?.status === 'prepared') {
        this.markApplied(project, step.id);
      }

      return {
        path: step.action.path,
        hash: step.after.hash,
        alreadyApplied: true,
        recovered: step.prior?.status === 'prepared',
      };
    }

    return this.write(project, workerId, runId, step.id, {
      ...step.action,
      expectedHash: step.before.hash,
    });
  }

  private markApplied(project: Project, actionId: string) {
    this.store.transaction(() => {
      this.store.markWrite(actionId, 'applied');
      project.revision++;
      this.store.saveProject(project);
    });
  }

  async write(
    project: Project,
    workerId: string,
    runId: string,
    actionId: string,
    action: Extract<
      Action,
      {
        type: 'write' | 'replace';
      }
    >,
  ): Promise<WorkspaceWrite> {
    const prior = this.store.journal(actionId);
    const current = await existing(project.root, action.path);

    if (prior) {
      if (
        prior.workerId !== workerId ||
        prior.runId !== runId ||
        prior.path !== action.path ||
        !['applied', 'prepared'].includes(prior.status)
      ) {
        throw new Error(
          'An earlier execution of this action is ambiguous. Review the journal; ' +
            'it will not be replayed.',
        );
      }

      const planned = editContent(action, {
        content: prior.before,
        hash: prior.beforeHash,
      });

      if (
        prior.beforeHash !== action.expectedHash ||
        prior.afterHash !== planned.hash ||
        prior.after !== planned.content
      ) {
        throw new Error(
          'An earlier execution has different action content. The journal will ' + 'not be overwritten.',
        );
      }

      if (current.hash === prior.afterHash) {
        if (prior.status === 'prepared') {
          this.markApplied(project, actionId);
        }

        return {
          path: action.path,
          hash: prior.afterHash,
          alreadyApplied: true,
          recovered: prior.status === 'prepared',
        };
      }
      // A crash before publication left an immutable prepared edit, not an
      // ambiguous command. Reapply ONLY when the disk is still the exact before.

      if (prior.status !== 'prepared' || current.hash !== prior.beforeHash) {
        throw new Error(
          'An earlier execution of this action is ambiguous. Review or roll back; ' +
            'it will not be replayed.',
        );
      }

      await atomicWrite(project.root, action.path, prior.after, prior.beforeHash);
      this.markApplied(project, actionId);

      return {
        path: action.path,
        hash: prior.afterHash,
        bytes: Buffer.byteLength(prior.after),
        recovered: true,
      };
    }

    if (current.hash !== action.expectedHash) {
      throw staleEdit(action.path, action.expectedHash, current.hash);
    }

    const next = editContent(action, current);
    const content = next.content;

    if (content === null) {
      throw new Error('A file edit must produce text. No journal or file was changed.');
    }
    this.store.prepareWrite({
      id: actionId,
      workerId,
      runId,
      path: action.path,
      before: current.content,
      after: content,
      beforeHash: current.hash,
      afterHash: next.hash,
      status: 'prepared',
      time: Date.now(),
    });
    await atomicWrite(project.root, action.path, content, current.hash);
    this.markApplied(project, actionId);

    return {
      path: action.path,
      hash: next.hash,
      bytes: Buffer.byteLength(content),
    };
  }

  async writeImage(
    project: Project,
    workerId: string,
    runId: string,
    actionId: string,
    relative: string,
    loadBytes: () => Promise<Buffer>,
    signal: AbortSignal,
  ): Promise<WorkspaceWrite> {
    signal.throwIfAborted();
    const prior = this.store.journal(actionId);
    validateRelative(relative);
    let image: Uint8Array<ArrayBuffer>;
    let hash: string;
    let dimensions: Pick<WorkspaceWrite, 'width' | 'height' | 'originalBytes'> = {};

    if (prior) {
      if (
        prior.workerId !== workerId ||
        prior.runId !== runId ||
        (prior.path !== relative && prior.path !== webImagePath(relative)) ||
        typeof prior.after === 'string' ||
        prior.beforeHash !== 'missing' ||
        !['prepared', 'applied'].includes(prior.status)
      ) {
        throw new Error('The image journal belongs to a different edit. The file was preserved.');
      }
      relative = prior.path;
      const currentHash = await imageFileHash(project.root, relative);
      signal.throwIfAborted();
      if (currentHash === prior.afterHash) {
        if (prior.status === 'prepared') {
          this.markApplied(project, actionId);
        }
        return {
          path: relative,
          hash: prior.afterHash,
          bytes: prior.after.length,
          alreadyApplied: true,
          recovered: prior.status === 'prepared',
        };
      }
      if (prior.status !== 'prepared' || currentHash !== 'missing') {
        throw new Error('The image changed after an earlier execution. The file was preserved.');
      }
      // Recover the exact prepared image without fetching a mutable source again.
      image = prior.after;
      validateProjectImage(Buffer.from(image.buffer, image.byteOffset, image.byteLength), relative);
      hash = prior.afterHash;
    } else {
      const currentHash = await imageFileHash(project.root, relative);
      signal.throwIfAborted();
      if (currentHash !== 'missing') {
        throw new Error(`Image destination already exists: ${relative}. Choose a new filename.`);
      }
      const bytes = await loadBytes();
      signal.throwIfAborted();
      validateProjectImage(bytes, relative);
      const optimized = await optimizeProjectImage(bytes, relative, signal);
      for (const destination of new Set([relative, optimized.path])) {
        const liveHash = await imageFileHash(project.root, destination);
        signal.throwIfAborted();
        if (liveHash !== 'missing') {
          throw new Error(`Image destination already exists: ${destination}. Choose a new filename.`);
        }
      }
      relative = optimized.path;
      validateProjectImage(optimized.bytes, relative);
      dimensions = { width: optimized.width, height: optimized.height, originalBytes: bytes.length };
      image = new Uint8Array(optimized.bytes);
      hash = digest(image);
      this.store.prepareWrite({
        id: actionId,
        workerId,
        runId,
        path: relative,
        before: null,
        after: image,
        beforeHash: 'missing',
        afterHash: hash,
        status: 'prepared',
        time: Date.now(),
      });
    }

    await atomicWrite(project.root, relative, image, 'missing', signal);
    this.markApplied(project, actionId);
    return { path: relative, hash, bytes: image.length, recovered: prior !== undefined, ...dimensions };
  }

  async rollback(
    project: Project,
    runId: string,
    relative?: string,
    expectedHash?: string,
  ): Promise<WorkspaceRollback> {
    if (relative !== undefined) {
      validateRelative(relative);
    }

    const writes = this.store
      .writes(runId)
      .filter(
        (journal) =>
          (journal.status === 'applied' || journal.status === 'prepared') &&
          (relative === undefined || journal.path === relative),
      );
    const imagePaths = new Set(
      writes.filter((write) => typeof write.after !== 'string').map((write) => write.path),
    );
    const readHash = async (relative: string) => {
      if (imagePaths.has(relative)) {
        return imageFileHash(project.root, relative);
      }
      return (await existing(project.root, relative)).hash;
    };
    if (relative !== undefined && expectedHash !== undefined && (await readHash(relative)) !== expectedHash) {
      throw new Error('The file changed after you opened the change review. Reload it before restoring.');
    }
    const simulated = new Map<string, string>();
    // Preflight all paths first. Do not clobber edits made after this run.

    for (const journal of writes) {
      const current = simulated.get(journal.path) ?? (await readHash(journal.path));

      if (
        current !== journal.afterHash &&
        !(journal.status === 'prepared' && current === journal.beforeHash)
      ) {
        throw new Error(`Rollback conflict: ${journal.path} has changed outside this run.`);
      }
      simulated.set(journal.path, journal.beforeHash);
    }

    for (const journal of writes) {
      if (journal.before === null) {
        const actualHash = await readHash(journal.path);

        if (
          actualHash !== journal.afterHash &&
          !(journal.status === 'prepared' && actualHash === 'missing')
        ) {
          throw new Error(`Rollback conflict: ${journal.path} changed during restoration.`);
        }

        if (actualHash !== 'missing') {
          const target = await safePath(project.root, journal.path);
          await fs.unlink(target);
        }
      } else {
        let expected = journal.afterHash;

        if (
          journal.status === 'prepared' &&
          (await existing(project.root, journal.path)).hash === journal.beforeHash
        ) {
          expected = journal.beforeHash;
        }

        await atomicWrite(project.root, journal.path, journal.before, expected);
      }
      this.store.markWrite(journal.id, 'rolled_back');
    }
    project.revision++;
    this.store.saveProject(project);

    return {
      restored: writes.length,
      warning:
        'Only Mitter file edits are restored. Command side effects, databases, ' +
        'and external systems are not rolled back.',
    };
  }
}
