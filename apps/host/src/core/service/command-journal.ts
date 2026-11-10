import path from 'node:path';
import type { Profile, Project, Worker } from '../../../../../packages/protocol/src/index.js';
import { runCommand, type CommandResult } from '../commands.js';
import type { Store } from '../database.js';
import { commandJournalSchema, type CommandJournal } from './schemas.js';

export class CommandJournalStore {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'saveProject'>) {}

  private read(actionId: string): CommandJournal | undefined {
    const raw = this.store.get(`command:${actionId}`);

    if (raw === undefined) {
      return;
    }

    const parsed = commandJournalSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error('Saved command history is invalid. Inspect it; the command will not be replayed.', {
        cause: parsed.error,
      });
    }

    return parsed.data;
  }

  finished(actionId: string): CommandResult | undefined {
    const previous = this.read(actionId);

    if (!previous) {
      return;
    }

    if (previous.status === 'finished') {
      return previous.result;
    }

    throw new Error(
      'Interrupted command quarantined. Inspect it and use Skip action; it will not be replayed.',
    );
  }

  async run(
    worker: Worker,
    project: Project,
    profile: Profile,
    actionId: string,
    dataDir: string,
    signal: AbortSignal,
    onOutput: (line: string) => void,
  ): Promise<CommandResult> {
    const previous = this.read(actionId);

    if (previous?.status === 'finished') {
      return previous.result;
    }

    if (previous) {
      throw new Error(
        'This command was interrupted and its side effects are unknown. Inspect them, then explicitly skip ' +
          'this step. It will not be replayed.',
      );
    }

    const key = `command:${actionId}`;
    const started: CommandJournal = { status: 'started', workerId: worker.id, profile, time: Date.now() };
    this.store.set(key, started);

    const scratch = path.join(dataDir, 'runtime', worker.id);
    const result = await runCommand(profile, project.root, scratch, signal, onOutput);
    project.revision++;
    this.store.saveProject(project);

    if (result.aborted || result.timedOut) {
      const interrupted: CommandJournal = { status: 'interrupted', workerId: worker.id, result };
      this.store.set(key, interrupted);

      if (result.timedOut) {
        throw new Error('Command timed out. Inspect side effects before skipping or replacing it.');
      }

      throw new Error('Command cancelled; side effects may remain.');
    }

    const finished: CommandJournal = { status: 'finished', workerId: worker.id, result };
    this.store.set(key, finished);

    return result;
  }
}
