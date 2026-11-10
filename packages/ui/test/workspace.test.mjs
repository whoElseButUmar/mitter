import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  WORKSPACE_KEY,
  emptyWorkspace,
  restoreWorkspace,
  reconcileWorkspace,
  reduceWorkspace,
  validateWorkspaceAction,
  WorkspaceStateSchema,
  WorkspaceActionSchema,
  HISTORY_LIMIT,
} from '../src/workspace.js';
import { restoreNavigation, selectProject, selectTask, activeTaskId } from '../src/workspace-state.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import { libraryRows } from '../src/library/rows.js';
import { SavedNavigationSchema, SavedWorkspaceStateSchema } from '../src/workspace/migrations.js';

const catalog = {
  projects: [
    { id: 'p', name: 'Project' },
    { id: 'q', name: 'Other' },
  ],
  tasks: [
    { id: 'a', projectId: 'p', name: 'A' },
    { id: 'b', projectId: 'p', name: 'B' },
    { id: 'c', projectId: 'p', name: 'C' },
    { id: 'd', projectId: 'q', name: 'D' },
  ],
};

function initial() {
  return reconcileWorkspace(emptyWorkspace(), catalog);
}

function close(state, id, group = 'batch') {
  return reduceWorkspace(state, { type: 'close', kind: 'task', id }, catalog, 1000, group);
}

test('navigation migrates selected workers and filters invalid remembered task ownership', () => {
  const legacy = restoreNavigation(null, 'b', catalog.projects, catalog.tasks);
  assert.equal(legacy.projectId, 'p');
  assert.equal(activeTaskId(legacy), 'b');
  const restored = restoreNavigation(
    { version: 1, projectId: 'missing', taskByProject: { p: 'd', q: 'd' } },
    'b',
    catalog.projects,
    catalog.tasks,
  );
  assert.equal(restored.projectId, 'p');
  assert.deepEqual(restored.taskByProject, { p: 'a', q: 'd' });
  assert.equal(selectProject(restored, 'missing', catalog.projects, catalog.tasks), restored);
  assert.equal(selectTask(restored, 'missing', catalog.projects, catalog.tasks), restored);
  assert.equal(activeTaskId(selectTask(restored, 'd', catalog.projects, catalog.tasks)), 'd');
});

test('workspace restore salvages fields, bounds history, and protects newer versions', () => {
  const saved = {
    ...initial(),
    revision: -1,
    openProjects: ['p', 'p', 1, 'deleted'],
    knownProjects: ['p', 'q'],
    knownTasks: ['a', 'b', 'c', 'd'],
    openTasks: { p: ['b', 'b', false, 'missing'], q: [] },
    taskByProject: { p: 'missing' },
    recentlyClosed: [
      {
        key: '1',
        group: 'g',
        kind: 'task',
        id: 'a',
        projectId: 'p',
        label: 'x'.repeat(500),
        index: 0,
        closedAt: 1000,
        wasSelected: 'yes',
      },
      {
        key: 'duplicate',
        group: 'g',
        kind: 'task',
        id: 'a',
        projectId: 'p',
        label: 'a',
        index: 0,
        closedAt: 1000,
      },
      {
        key: 'invalid',
        group: 'g',
        kind: 'task',
        id: 'c',
        projectId: 'p',
        label: 'c',
        index: 0,
        closedAt: Infinity,
      },
    ],
  };
  const restored = restoreWorkspace(saved, null, null, catalog);
  assert.equal(restored.revision, 0);
  assert.deepEqual(restored.openProjects, ['p']);
  assert.deepEqual(restored.openTasks.p, ['b']);
  assert.equal(restored.taskByProject.p, 'b');
  assert.equal(restored.recentlyClosed.length, 1);
  assert.equal(restored.recentlyClosed[0].label.length, 300);
  assert.equal(restored.recentlyClosed[0].wasSelected, false);
  assert.ok(WorkspaceStateSchema.safeParse(restored).success);
  assert.throws(() => restoreWorkspace({ version: 3 }, null, null, catalog), /newer Mitter/);
  assert.equal(restoreWorkspace(null, null, 'b', catalog).taskByProject.p, 'b');

  const history = Array.from({ length: HISTORY_LIMIT + 30 }, (_, index) => ({
    key: String(index),
    group: 'g',
    kind: 'task',
    id: String(index),
    projectId: 'p',
    label: '',
    index,
    closedAt: 1000,
  }));
  assert.equal(
    restoreWorkspace({ ...initial(), recentlyClosed: history }, null, null, catalog).recentlyClosed.length,
    HISTORY_LIMIT,
  );
});

test('explicit workspace migrations salvage null fields without retaining malformed serialized entries', () => {
  const navigation = SavedNavigationSchema.parse({
    version: 1,
    projectId: null,
    taskByProject: { p: null, q: 'd' },
  });
  assert.equal(navigation.projectId, '');
  assert.equal(navigation.taskByProject.p, undefined);
  assert.equal(navigation.taskByProject.q, 'd');

  const migrated = SavedWorkspaceStateSchema.parse({
    version: 2,
    revision: null,
    projectId: 'p',
    taskByProject: null,
    openProjects: ['p', null, 'p'],
    openTasks: { p: ['a', null, 'a'], q: null },
    knownProjects: null,
    knownTasks: [],
    recentlyClosed: [null, {}],
  });
  assert.equal(migrated.revision, 0);
  assert.deepEqual(migrated.openProjects, ['p']);
  assert.deepEqual(migrated.openTasks, { p: ['a'], q: [] });
  assert.deepEqual(migrated.recentlyClosed, []);
  assert.equal(WorkspaceStateSchema.safeParse(migrated).success, true);
});

test('malformed storage envelopes and future workspace versions cannot cause writes or broadcasts', async () => {
  for (const stored of [null, [], { [WORKSPACE_KEY]: { version: 3, recentlyClosed: ['retained'] } }]) {
    const writes = [];
    const broadcasts = [];
    const store = new WorkspaceStore(
      {
        get: async () => stored,
        set: async (value) => writes.push(value),
      },
      (value) => broadcasts.push(value),
    );
    await assert.rejects(store.sync(catalog));
    assert.deepEqual(writes, []);
    assert.deepEqual(broadcasts, []);
    assert.equal(store.peek(), undefined);
    await store.quiesce();
  }
});

test('tab reduction is immutable and restores grouped order and selection', () => {
  const original = initial();
  const before = JSON.stringify(original);
  const selected = reduceWorkspace(original, { type: 'open', kind: 'task', id: 'b' }, catalog);
  const closed = reduceWorkspace(
    selected,
    { type: 'closeAll', kind: 'task', projectId: 'p' },
    catalog,
    1000,
    'group',
  );
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(closed.openTasks.p, []);
  assert.equal(closed.taskByProject.p, '');
  assert.deepEqual(
    closed.recentlyClosed.map((tab) => tab.index),
    [2, 1, 0],
  );
  const restored = reduceWorkspace(closed, { type: 'restoreGroup', group: 'group' }, catalog);
  assert.deepEqual(restored.openTasks.p, ['a', 'b', 'c']);
  assert.equal(restored.taskByProject.p, 'b');
  assert.equal(restored.recentlyClosed.length, 0);
  const right = reduceWorkspace(selected, { type: 'closeRight', kind: 'task', id: 'b' }, catalog);
  assert.deepEqual(right.openTasks.p, ['a', 'b']);
  const others = reduceWorkspace(selected, { type: 'closeOthers', kind: 'task', id: 'b' }, catalog);
  assert.deepEqual(others.openTasks.p, ['b']);
  const projectClosed = reduceWorkspace(selected, { type: 'close', kind: 'project', id: 'p' }, catalog);
  assert.deepEqual(projectClosed.openTasks.p, ['a', 'b', 'c']);
  assert.equal(projectClosed.projectId, 'q');
  const projectRestored = reduceWorkspace(projectClosed, { type: 'restoreLast', kind: 'project' }, catalog);
  assert.equal(projectRestored.projectId, 'p');
});

test('catalog reconciliation auto-opens only new records and removes vanished task ownership', () => {
  const state = close(initial(), 'b');
  const nextCatalog = {
    ...catalog,
    tasks: [...catalog.tasks, { id: 'e', projectId: 'p' }],
  };
  const next = reconcileWorkspace(state, nextCatalog);
  assert.deepEqual(next.openTasks.p, ['a', 'c', 'e']);
  const withoutProject = { projects: [{ id: 'q' }], tasks: catalog.tasks };
  const orphaned = reconcileWorkspace(next, withoutProject);
  assert.deepEqual(Object.keys(orphaned.openTasks), ['q']);
  assert.deepEqual(orphaned.knownTasks, ['d']);
  assert.deepEqual(reduceWorkspace(orphaned, { type: 'restoreLast' }, withoutProject).openProjects, ['q']);
});

test('dictionary-shaped project IDs do not modify object prototypes', () => {
  const unusual = {
    projects: [{ id: '__proto__' }, { id: 'constructor' }],
    tasks: [{ id: 'task', projectId: '__proto__' }],
  };
  const state = restoreWorkspace(null, null, null, unusual);
  assert.deepEqual(state.openTasks.__proto__, ['task']);
  assert.equal(state.taskByProject.__proto__, 'task');
  assert.equal(Object.getPrototypeOf(state.openTasks), null);
  assert.equal(
    restoreNavigation(null, 'task', unusual.projects, unusual.tasks).taskByProject.__proto__,
    'task',
  );
  assert.throws(() => validateWorkspaceAction({ type: '__proto__' }), /Unknown workspace action/);
});

test('serialized workspace dictionaries retain built-in project names without changing prototypes', async () => {
  const unusual = {
    projects: [{ id: '__proto__' }, { id: 'constructor' }],
    tasks: [
      { id: 'a', projectId: '__proto__' },
      { id: 'b', projectId: '__proto__' },
      { id: 'c', projectId: 'constructor' },
    ],
  };
  const saved = JSON.parse(
    JSON.stringify({
      ...emptyWorkspace(),
      projectId: '__proto__',
      taskByProject: Object.fromEntries([
        ['__proto__', 'b'],
        ['constructor', ''],
      ]),
      openProjects: ['__proto__'],
      openTasks: Object.fromEntries([
        ['__proto__', ['b']],
        ['constructor', []],
      ]),
      knownProjects: ['__proto__', 'constructor'],
      knownTasks: ['a', 'b', 'c'],
    }),
  );

  for (const schema of [WorkspaceStateSchema, SavedWorkspaceStateSchema]) {
    const parsed = schema.parse(saved);
    assert.equal(Object.hasOwn(parsed.openTasks, '__proto__'), true);
    assert.deepEqual(parsed.openTasks.__proto__, ['b']);
    assert.equal(parsed.taskByProject.__proto__, 'b');
    assert.notEqual(Object.getPrototypeOf(parsed.openTasks), parsed.openTasks.__proto__);
  }

  const legacy = { version: 1, projectId: '__proto__', taskByProject: saved.taskByProject };
  assert.equal(SavedNavigationSchema.parse(legacy).taskByProject.__proto__, 'b');
  assert.equal(restoreNavigation(legacy, null, unusual.projects, unusual.tasks).taskByProject.__proto__, 'b');
  const restored = restoreWorkspace(saved, null, null, unusual);
  assert.deepEqual(restored.openTasks.__proto__, ['b']);
  assert.deepEqual(restored.openTasks.constructor, []);
  assert.equal(restored.taskByProject.__proto__, 'b');
  assert.equal(Object.getPrototypeOf(restored.openTasks), null);

  const writes = [];
  const store = new WorkspaceStore(
    {
      get: async () => ({ [WORKSPACE_KEY]: saved }),
      set: async (value) => writes.push(value),
    },
    () => {},
  );
  const synced = await store.sync(unusual);
  assert.deepEqual(synced.openTasks.__proto__, ['b']);
  assert.deepEqual(WorkspaceStateSchema.parse(synced).openTasks.__proto__, ['b']);
  assert.deepEqual(writes[0][WORKSPACE_KEY].openTasks.__proto__, ['b']);
  await store.quiesce();
});

test('workspace dictionary schemas reject non-object maps rather than treating entry arrays as records', () => {
  for (const field of ['taskByProject', 'openTasks']) {
    for (const value of [null, [], [['p', 'a']], new Date(0), new Map()]) {
      assert.equal(WorkspaceStateSchema.safeParse({ ...initial(), [field]: value }).success, false);
      assert.deepEqual(
        Object.keys(SavedWorkspaceStateSchema.parse({ ...initial(), [field]: value })[field]),
        [],
      );
    }
  }

  const invalidSelection = {
    ...initial(),
    taskByProject: Object.fromEntries([['__proto__', { polluted: true }]]),
  };
  assert.equal(WorkspaceStateSchema.safeParse(invalidSelection).success, false);
  assert.equal(
    Object.hasOwn(SavedWorkspaceStateSchema.parse(invalidSelection).taskByProject, '__proto__'),
    false,
  );
});

test('action validation preserves optional legacy scopes and descriptive errors', () => {
  assert.deepEqual(
    validateWorkspaceAction({
      type: 'restoreLast',
      kind: '',
      projectId: '',
      extra: true,
    }),
    {
      type: 'restoreLast',
    },
  );
  assert.deepEqual(
    validateWorkspaceAction({
      type: 'open',
      kind: 'task',
      id: 'a',
      extra: true,
    }),
    {
      type: 'open',
      kind: 'task',
      id: 'a',
    },
  );
  assert.throws(() => validateWorkspaceAction(null), /Invalid workspace action/);
  assert.throws(() => validateWorkspaceAction({ type: 'open', kind: 'wrong', id: 'a' }), /Invalid tab kind/);
  assert.throws(
    () => validateWorkspaceAction({ type: 'open', kind: 'task', id: '' }),
    /Invalid workspace id/,
  );
  assert.ok(WorkspaceActionSchema.safeParse({ type: 'clearHistory' }).success);
});

test('store serializes writes, publishes only after durability, and returns isolated snapshots', async () => {
  const gate = Promise.withResolvers();
  const writes = [];
  const published = [];
  const store = new WorkspaceStore(
    {
      get: async () => ({}),
      set: async (values) => {
        writes.push(values[WORKSPACE_KEY]);
        await gate.promise;
      },
    },
    (state) => published.push(state),
  );
  const syncing = store.sync(catalog);
  const dispatching = store.dispatch({ type: 'close', kind: 'task', id: 'a' }, catalog);
  await setImmediate();
  assert.equal(writes.length, 1);
  assert.equal(published.length, 0);
  gate.resolve();
  const synced = await syncing;
  const dispatched = await dispatching;
  assert.equal(synced.revision, 1);
  assert.equal(dispatched.revision, 2);
  assert.deepEqual(dispatched.openTasks.p, ['b', 'c']);
  assert.equal(published.length, 2);
  dispatched.openTasks.p.push('mutated');
  assert.deepEqual(store.peek().openTasks.p, ['b', 'c']);
  await store.quiesce();
  await assert.rejects(store.sync(catalog), /Data reset in progress/);
});

test('failed storage write is not broadcast and the serialized queue can retry', async () => {
  let fail = true;
  const published = [];
  const store = new WorkspaceStore(
    {
      get: async () => ({}),
      set: async () => {
        if (fail) {
          throw new Error('disk unavailable');
        }
      },
    },
    (state) => published.push(state),
  );
  await assert.rejects(store.sync(catalog), /disk unavailable/);
  assert.equal(store.peek(), undefined);
  assert.equal(published.length, 0);
  fail = false;
  const state = await store.sync(catalog);
  assert.equal(state.revision, 1);
  await store.sync(catalog);
  assert.equal(published.length, 1);
});

test('library search/filter/history resolve retained data and scope without changing workspace state', () => {
  const state = close(initial(), 'b');
  const data = {
    view: 'tasks',
    scopeProjectId: 'p',
    state,
    projects: catalog.projects.map((project) => ({
      ...project,
      label: project.name,
      subtitle: '/root',
      status: 'idle',
    })),
    tasks: catalog.tasks.map((task, index) => {
      let status = 'working';

      if (index === 1) {
        status = 'blocked';
      }

      return {
        ...task,
        label: task.name,
        subtitle: 'Goal',
        status,
        createdAt: index,
      };
    }),
  };
  const before = JSON.stringify(state);
  assert.deepEqual(
    libraryRows(data, 'tasks', 'p', 'closed', '').map((row) => row.id),
    ['b'],
  );
  assert.deepEqual(
    libraryRows(data, 'tasks', '', 'active', '').map((row) => row.id),
    ['d', 'c', 'a'],
  );
  assert.deepEqual(
    libraryRows(data, 'tasks', 'p', 'attention', ' project ').map((row) => row.id),
    ['b'],
  );
  assert.equal(libraryRows(data, 'history', 'p', 'complete', '')[0].available, true);
  data.tasks = data.tasks.filter((task) => task.id !== 'b');
  assert.equal(libraryRows(data, 'history', '', 'all', '')[0].available, false);
  assert.equal(JSON.stringify(state), before);
});
