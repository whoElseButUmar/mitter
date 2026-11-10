import { randomUUID } from 'node:crypto';
import { coreRpcRegistry, parseRpcParams } from '../../../../../packages/protocol/src/rpc.js';
import type { ProjectContext } from '../../../../../packages/protocol/src/rpc.js';
export { projectContextSchema } from '../../../../../packages/protocol/src/rpc.js';
import { id, text, type Project, type Worker } from '../../../../../packages/protocol/src/index.js';
import { parseProfile } from '../commands.js';
import type { Store } from '../database.js';
import { canonicalRoot, overlaps } from '../workspace.js';
import { parseDisplayName, parseOptionalFlag } from './request-parsing.js';

/** Owns registered projects; worktree views share the base project's revision. */
export class ProjectCatalog {
  readonly projects = new Map<string, Project>();

  constructor(
    private readonly store: Pick<Store, 'projects' | 'saveProject'>,
    private readonly dataDir: string,
    private readonly changed: () => void,
  ) {
    for (const project of store.projects()) {
      this.projects.set(project.id, project);
    }
  }

  get(value: unknown): Project {
    const project = this.projects.get(id(value, 'project ID'));

    if (!project) {
      throw new Error('Project not found.');
    }

    return project;
  }

  private save(project: Project): void {
    this.store.saveProject(project);
    this.changed();
  }

  async add(params: Record<string, unknown>): Promise<Project> {
    if (this.projects.size >= 50) {
      throw new Error('This preview supports at most 50 saved projects.');
    }

    const requestedRoot = text(params.root, 'project root', 2000);
    const name = text(params.name, 'project name', 60);
    parseRpcParams(coreRpcRegistry, 'project.add', params);
    const root = await canonicalRoot(requestedRoot);

    if (overlaps(root, this.dataDir)) {
      throw new Error('Do not register Mitter’s own data directory.');
    }

    for (const existing of this.projects.values()) {
      if (overlaps(root, existing.root)) {
        throw new Error(
          'This folder overlaps an existing project. Reuse that project so workers share its lock.',
        );
      }
    }

    const project: Project = {
      id: randomUUID(),
      name,
      root,
      profiles: [],
      revision: 0,
    };
    this.projects.set(project.id, project);
    this.save(project);

    return project;
  }

  context(params: Record<string, unknown>): ProjectContext {
    const project = this.get(params.projectId);

    if (parseOptionalFlag(params.save, 'project context save') === true) {
      const mission = text(params.mission ?? '', 'project goal', 4000, true);
      const conventions = text(params.conventions ?? '', 'conventions', 4000, true);
      parseRpcParams(coreRpcRegistry, 'project.context', params);
      project.mission = mission;
      project.conventions = conventions;
      this.save(project);
    } else {
      parseRpcParams(coreRpcRegistry, 'project.context', params);
    }

    return { mission: project.mission ?? '', conventions: project.conventions ?? '' };
  }

  rename(projectId: unknown, name: unknown): Project {
    const project = this.get(projectId);
    const parsedName = parseDisplayName(name, 'project name');
    parseRpcParams(coreRpcRegistry, 'project.rename', { projectId, name });
    project.name = parsedName;
    this.save(project);

    return project;
  }

  setProfile(project: Project, raw: unknown): Project {
    const profile = parseProfile(raw);

    if (project.profiles.length >= 16 && !project.profiles.some((existing) => existing.id === profile.id)) {
      throw new Error('At most 16 command profiles per project.');
    }

    parseRpcParams(coreRpcRegistry, 'project.profile', { projectId: project.id, profile });
    project.profiles = project.profiles.filter((existing) => existing.id !== profile.id).concat(profile);
    project.revision++;
    this.save(project);

    return project;
  }

  executionProject(worker: Worker): Project {
    const base = this.get(worker.projectId);

    if (!worker.worktree) {
      return base;
    }

    const derived: Project = { ...base, root: worker.worktree.root, sourceRoot: base.root };
    Object.defineProperty(derived, 'revision', {
      enumerable: true,
      get: () => base.revision,
      set: (revision: number) => {
        base.revision = revision;
      },
    });

    return derived;
  }
}
