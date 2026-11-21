import assert from 'node:assert/strict';
import test from 'node:test';
import { batch, createEffect, createRoot, createSignal } from 'solid-js';
import { projectSchema, snapshotSchema } from '../../../../packages/protocol/src/index.ts';
import { DEFAULT_SETTINGS } from '../../../../packages/protocol/src/model-settings.ts';
import { emptyWorkspace } from '../../../../packages/ui/src/workspace.ts';
import { ToastCenter } from '../../../../packages/ui/src/toast.ts';
import { TaskOutput } from '../../src/ui/task-output.ts';
import { createWorkspaceTabs } from '../../src/ui/workspace-tabs.ts';
import { worker, flush } from './fixtures.mjs';

const project = projectSchema.parse({
  id: 'project_1',
  name: 'Demo',
  root: '/project',
  profiles: [],
  revision: 1,
});

function snapshot(events = []) {
  return snapshotSchema.parse({
    protocol: 'mitter/1',
    projects: [project],
    workers: [worker()],
    events,
    settings: DEFAULT_SETTINGS,
    runtime: { node: '', workflow: '', models: 'Not connected' },
  });
}

function event(id, message, workerId = 'worker_1') {
  return { id, message, workerId, time: id * 1000, kind: 'action' };
}

function outputOwner(rpc, events = []) {
  return createRoot((dispose) => {
    const [task, setTask] = createSignal(worker());
    const [currentProject, setProject] = createSignal(project);
    const [connected, setConnected] = createSignal(true);
    const [modal, setModal] = createSignal('');
    const [state, setSnapshot] = createSignal(snapshot(events));
    const notices = [];
    const modals = [];
    const actions = [];
    const copies = [];
    const output = new TaskOutput({
      snapshot: state,
      selected: () => task()?.id || '',
      worker: task,
      project: currentProject,
      connected,
      rpc,
      notice: (message) => notices.push(message),
      success: () => {},
      copy: async (text) => {
        copies.push(text);
      },
      action: async (method, params) => {
        actions.push({ method, params });
      },
      modal,
      setModal: (value) => {
        setModal(value);
        modals.push(value);
      },
    });

    return {
      dispose,
      output,
      setTask,
      setProject,
      setConnected,
      setSnapshot,
      notices,
      modals,
      modal,
      setModal,
      actions,
      copies,
    };
  });
}

test('choosing the same listed file issues a new preview request with its task and path intact', async () => {
  const owner = outputOwner(async (method) => {
    if (method === 'worker.browse') {
      return { root: '/project', files: ['index.html'] };
    }
    return [];
  });
  const requests = [];
  const stopObserving = createRoot((dispose) => {
    createEffect(() => {
      requests.push({ request: owner.output.previewRequest(), path: owner.output.file() });
    });
    return dispose;
  });
  try {
    await owner.output.browseFiles();
    const listing = owner.output.fileLibrary();
    assert.ok(listing);
    owner.output.previewListedFile(listing, 'index.html');
    owner.output.setExpanded(false);
    owner.setModal('files');
    owner.output.previewListedFile(listing, 'index.html');
    assert.deepEqual(requests, [
      { request: 0, path: '' },
      { request: 1, path: 'index.html' },
      { request: 2, path: 'index.html' },
    ]);
    assert.equal(owner.output.fileLibrary(), listing);
    assert.equal(listing.workerId, 'worker_1');
    assert.equal(owner.output.expanded(), true);
    assert.equal(owner.output.view(), 'result');
    assert.equal(owner.modal(), '');
  } finally {
    stopObserving();
    owner.dispose();
  }
});

test('reset and disposal retire preview requests without reviving a stale file selection', async () => {
  const owner = outputOwner(async (method) => {
    if (method === 'worker.browse') {
      return { root: '/project', files: ['index.html'] };
    }
    return [];
  });
  try {
    await owner.output.browseFiles();
    const listing = owner.output.fileLibrary();
    assert.ok(listing);
    owner.output.previewListedFile(listing, 'index.html');
    const first = owner.output.previewRequest();
    owner.output.reset();
    const reset = owner.output.previewRequest();
    assert.ok(reset > first);
    owner.output.previewListedFile(listing, 'index.html');
    assert.equal(owner.output.previewRequest(), reset);
    assert.equal(owner.output.file(), '');
    owner.output.preview('index.html');
    const next = owner.output.previewRequest();
    assert.ok(next > reset);
    owner.dispose();
    const disposed = owner.output.previewRequest();
    assert.ok(disposed > next);
    owner.output.preview('index.html');
    assert.equal(owner.output.previewRequest(), disposed);
    assert.equal(owner.output.file(), '');
  } finally {
    owner.dispose();
  }
});

test('changed files reject stale revisions and clear selection on disconnect without reviving after disposal', async () => {
  const reads = [];
  const owner = outputOwner((method, params) => {
    assert.equal(method, 'worker.files');
    const pending = Promise.withResolvers();
    reads.push({ params, ...pending });
    return pending.promise;
  });

  try {
    assert.equal(reads.length, 1);
    owner.output.preview('old.ts');
    owner.setProject({ ...project, revision: 2 });
    assert.equal(reads.length, 2);

    reads[1].resolve([{ path: 'current.ts', status: 'changed', bytes: 10 }]);
    await flush();
    reads[0].resolve([{ path: 'old.ts', status: 'changed', bytes: 1 }]);
    await flush();
    assert.deepEqual(
      owner.output.files().map((file) => file.path),
      ['current.ts'],
    );

    owner.setConnected(false);
    assert.deepEqual(owner.output.files(), []);
    assert.equal(owner.output.file(), '');
    owner.setConnected(true);
    assert.equal(reads.length, 3);
    owner.dispose();
    reads[2].resolve([{ path: 'disposed.ts', status: 'changed', bytes: 5 }]);
    await flush();
    assert.deepEqual(owner.output.files(), []);
    assert.deepEqual(owner.notices, []);
  } finally {
    owner.dispose();
  }
});

test('file generations distinguish leaving a task and returning to the same ID', async () => {
  const reads = [];
  const owner = outputOwner(() => {
    const pending = Promise.withResolvers();
    reads.push(pending);
    return pending.promise;
  });

  try {
    batch(() => {
      owner.setTask(worker({ id: 'worker_2' }));
      owner.output.reset();
    });
    batch(() => {
      owner.setTask(worker());
      owner.output.reset();
    });
    assert.equal(reads.length, 3);
    reads[2].resolve([{ path: 'current.ts', status: 'changed', bytes: 2 }]);
    await flush();
    reads[0].resolve([{ path: 'stale.ts', status: 'changed', bytes: 1 }]);
    reads[1].reject(new Error('Superseded task failed.'));
    await flush();
    assert.deepEqual(
      owner.output.files().map((file) => file.path),
      ['current.ts'],
    );
    assert.deepEqual(owner.notices, []);
  } finally {
    owner.dispose();
  }
});

test('changed-file errors remain actionable and retry cannot duplicate or outlive its run', async () => {
  const reads = [];
  const owner = outputOwner(() => {
    const pending = Promise.withResolvers();
    reads.push(pending);
    return pending.promise;
  });
  try {
    assert.equal(owner.output.filesLoading(), true);
    reads[0].reject(new Error('Files could not be read.'));
    await flush();
    assert.equal(owner.output.filesLoading(), false);
    assert.equal(owner.output.filesError(), 'Files could not be read.');
    assert.deepEqual(owner.notices, []);
    const retry = owner.output.retryFiles();
    await owner.output.retryFiles();
    assert.equal(reads.length, 2);
    assert.equal(owner.output.filesLoading(), true);
    reads[1].resolve([{ path: 'ready.ts', status: 'changed', bytes: 5 }]);
    await retry;
    assert.equal(owner.output.filesError(), '');
    assert.equal(owner.output.filesLoading(), false);
    assert.equal(owner.output.files()[0].path, 'ready.ts');

    owner.setTask(worker({ runId: 'next_run' }));
    assert.equal(reads.length, 3);
    owner.setTask(worker({ runId: 'newest_run' }));
    assert.equal(reads.length, 4);
    reads[2].reject(new Error('Previous run failed.'));
    await flush();
    assert.equal(owner.output.filesLoading(), true);
    assert.equal(owner.output.filesError(), '');
    reads[3].resolve([]);
    await flush();
    assert.equal(owner.output.filesLoading(), false);
    assert.deepEqual(owner.output.files(), []);
    owner.setConnected(false);
    await owner.output.retryFiles();
    assert.equal(reads.length, 4);
    assert.equal(owner.output.filesError(), '');
  } finally {
    owner.dispose();
  }
});

test('activity retry recovers the failed page and preserves the older-page cursor', async () => {
  const pages = [];
  const owner = outputOwner((method, params) => {
    if (method === 'worker.files') {
      return Promise.resolve([]);
    }
    const pending = Promise.withResolvers();
    pages.push({ params, ...pending });
    return pending.promise;
  });
  try {
    owner.output.setView('activity');
    pages[0].reject(new Error('Activity unavailable.'));
    await flush();
    assert.equal(owner.output.historyError(), 'Activity unavailable.');
    const retry = owner.output.retryHistory();
    await owner.output.retryHistory();
    assert.equal(pages.length, 2);
    assert.deepEqual(pages[1].params, { workerId: 'worker_1' });
    pages[1].resolve({ events: [event(9, 'Current page')], hasMore: true, before: 9 });
    await retry;
    assert.equal(owner.output.historyError(), '');
    const older = owner.output.loadHistory();
    pages[2].reject(new Error('Older page unavailable.'));
    await older;
    const retryOlder = owner.output.retryHistory();
    assert.deepEqual(pages[3].params, { workerId: 'worker_1', before: 9 });
    pages[3].resolve({ events: [event(3, 'Older page')], hasMore: false, before: null });
    await retryOlder;
    assert.deepEqual(
      owner.output.activity().map((item) => item.id),
      [9, 3],
    );
    assert.equal(owner.output.historyError(), '');
    assert.deepEqual(owner.notices, []);
  } finally {
    owner.dispose();
  }
});

test('a file menu from a previous run cannot open a path in the replacement workspace', async () => {
  const owner = outputOwner(async () => []);
  try {
    const menu = owner.output.fileMenu('worker_1', 'old.ts');
    owner.setTask(worker({ runId: 'replacement_run' }));
    menu.find((item) => item.id === 'finder').run();
    menu.find((item) => item.id === 'preview').run();
    assert.deepEqual(owner.actions, []);
    assert.equal(owner.output.file(), '');
    const current = owner.output.fileMenu('worker_1', 'current.ts');
    current.find((item) => item.id === 'finder').run();
    assert.deepEqual(owner.actions, [
      {
        method: 'worker.openFile',
        params: { workerId: 'worker_1', path: 'current.ts', application: 'finder' },
      },
    ]);
  } finally {
    owner.dispose();
  }
});

test('history merges live and saved events once, sorts newest first, and uses the older-page cursor', async () => {
  const pages = [];
  const owner = outputOwner(
    (method, params) => {
      if (method === 'worker.files') {
        return Promise.resolve([]);
      }
      assert.equal(method, 'worker.history');
      const pending = Promise.withResolvers();
      pages.push({ params, ...pending });
      return pending.promise;
    },
    [event(3, 'live newest'), event(2, 'live duplicate'), event(8, 'other task', 'worker_2')],
  );

  try {
    owner.output.setView('activity');
    assert.equal(pages.length, 1);
    assert.equal(owner.output.historyBusy(), true);
    pages[0].resolve({
      events: [event(2, 'saved duplicate'), event(1, 'saved older')],
      hasMore: true,
      before: 1,
    });
    await flush();
    assert.deepEqual(
      owner.output.activity().map((item) => [item.id, item.message]),
      [
        [3, 'live newest'],
        [2, 'saved duplicate'],
        [1, 'saved older'],
      ],
    );
    assert.equal(owner.output.historyMore(), true);
    assert.equal(owner.output.historyBusy(), false);

    const older = owner.output.loadHistory();
    assert.deepEqual(pages[1].params, { workerId: 'worker_1', before: 1 });
    pages[1].resolve({ events: [event(0, 'oldest')], hasMore: false, before: null });
    await older;
    assert.deepEqual(
      owner.output.activity().map((item) => item.id),
      [3, 2, 1, 0],
    );
    assert.equal(owner.output.historyMore(), false);
  } finally {
    owner.dispose();
  }
});

test('overlapping history pages retain each saved event once without dropping older unique events', async () => {
  let page = 0;
  const owner = outputOwner(async (method) => {
    if (method === 'worker.files') {
      return [];
    }

    page++;
    return {
      events: [event(100, 'Repeated event'), event(page, 'Page ' + page)],
      hasMore: true,
      before: page,
    };
  });

  try {
    await owner.output.loadHistory(true);

    for (let index = 0; index < 12; index++) {
      await owner.output.loadHistory();
    }

    // Rendering already hid duplicates; the retained pages must also stay deduplicated.
    assert.equal(owner.output.savedActivity[0]().length, 14);
    assert.deepEqual(
      owner.output.activity().map((item) => item.id),
      [100, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    );
  } finally {
    owner.dispose();
  }
});

test('history failures show the explanation without an Error prefix and release busy state', async () => {
  const owner = outputOwner(async (method) => {
    if (method === 'worker.files') {
      return [];
    }

    throw new Error('History is unavailable. Reconnect, then open Activity again.');
  });

  try {
    await owner.output.loadHistory(true);
    assert.equal(owner.output.historyError(), 'History is unavailable. Reconnect, then open Activity again.');
    assert.deepEqual(owner.notices, []);
    assert.equal(owner.output.historyBusy(), false);
  } finally {
    owner.dispose();
  }
});

test('output disposal releases retained history and file listings without closing a replacement dialog', async () => {
  const owner = outputOwner(
    async (method) => {
      if (method === 'worker.files') {
        return [{ path: 'current.ts', status: 'changed', bytes: 1 }];
      }

      if (method === 'worker.browse') {
        return { root: '/project', files: ['current.ts'] };
      }

      return { events: [event(1, 'Saved event')], hasMore: true, before: 1 };
    },
    [event(2, 'Live event')],
  );

  await flush();
  await owner.output.loadHistory(true);
  await owner.output.browseFiles();
  owner.setModal('replacement');
  assert.equal(owner.output.activity().length, 2);
  owner.dispose();

  assert.deepEqual(owner.output.activity(), []);
  assert.deepEqual(owner.output.savedActivity[0](), []);
  assert.deepEqual(owner.output.files(), []);
  assert.equal(owner.output.fileLibrary(), undefined);
  assert.equal(owner.output.historyBusy(), false);
  assert.equal(owner.output.historyMore(), false);
  assert.equal(owner.modal(), 'replacement');
});

test('an older history completion cannot clear the current request busy state or install stale events', async () => {
  const pages = [];
  const owner = outputOwner((method) => {
    if (method === 'worker.files') {
      return Promise.resolve([]);
    }
    const pending = Promise.withResolvers();
    pages.push(pending);
    return pending.promise;
  });

  try {
    owner.output.setView('activity');
    const latest = owner.output.loadHistory(true);
    pages[0].resolve({ events: [event(1, 'stale')], hasMore: true, before: 1 });
    await flush();
    assert.equal(owner.output.historyBusy(), true);
    assert.deepEqual(owner.output.activity(), []);
    pages[1].resolve({ events: [event(2, 'current')], hasMore: false, before: null });
    await latest;
    assert.equal(owner.output.historyBusy(), false);
    assert.deepEqual(
      owner.output.activity().map((item) => item.message),
      ['current'],
    );
  } finally {
    owner.dispose();
  }
});

test('history reset and owner disposal invalidate late success and failure callbacks', async () => {
  const pages = [];
  const owner = outputOwner((method) => {
    if (method === 'worker.files') {
      return Promise.resolve([]);
    }
    const pending = Promise.withResolvers();
    pages.push(pending);
    return pending.promise;
  });

  owner.output.setView('activity');
  owner.output.reset();
  pages[0].resolve({ events: [event(1, 'before reset')], hasMore: true, before: 1 });
  await flush();
  assert.deepEqual(owner.output.activity(), []);
  assert.equal(owner.output.historyMore(), false);
  assert.equal(owner.output.historyBusy(), false);

  const pending = owner.output.loadHistory(true);
  owner.dispose();
  pages[1].reject(new Error('Disposed request failed.'));
  await pending;
  assert.deepEqual(owner.notices, []);
  assert.deepEqual(owner.output.activity(), []);
});

test('file browsing deduplicates current reads and cannot reopen a dialog after reset or disposal', async () => {
  const reads = [];
  const owner = outputOwner((method) => {
    if (method === 'worker.files') {
      return Promise.resolve([]);
    }
    assert.equal(method, 'worker.browse');
    const pending = Promise.withResolvers();
    reads.push(pending);
    return pending.promise;
  });

  try {
    const current = owner.output.browseFiles();
    assert.equal(owner.output.browsing(), true);
    await owner.output.browseFiles();
    assert.equal(reads.length, 1);
    reads[0].resolve({ root: '/project', files: ['current.ts'] });
    await current;
    assert.equal(owner.output.browsing(), false);
    assert.deepEqual(owner.output.fileLibrary(), { workerId: 'worker_1', files: ['current.ts'] });
    assert.deepEqual(owner.modals, ['files']);

    const resetting = owner.output.browseFiles();
    owner.output.reset();
    assert.equal(owner.output.browsing(), false);
    reads[1].resolve({ root: '/project', files: ['before-reset.ts'] });
    await resetting;
    assert.deepEqual(owner.modals, ['files', '']);

    const closing = owner.output.browseFiles();
    owner.dispose();
    assert.equal(owner.output.browsing(), false);
    reads[2].reject(new Error('Owner closed.'));
    await closing;
    await owner.output.browseFiles();
    assert.equal(reads.length, 3);
    assert.deepEqual(owner.notices, []);
    assert.deepEqual(owner.modals, ['files', '']);
  } finally {
    owner.dispose();
  }
});

test('file browsing requires a connected task and its matching project before requesting files', async () => {
  const requests = [];
  const owner = outputOwner(async (method) => {
    if (method === 'worker.browse') {
      requests.push(method);
      return { root: '/project', files: [] };
    }
    return [];
  });
  try {
    owner.setConnected(false);
    await owner.output.browseFiles();
    owner.setTask(undefined);
    owner.setConnected(true);
    await owner.output.browseFiles();
    owner.setTask(worker());
    owner.setProject(undefined);
    await owner.output.browseFiles();
    owner.setProject({ ...project, id: 'other_project' });
    await owner.output.browseFiles();
    assert.deepEqual(requests, []);
    assert.equal(owner.output.browsing(), false);
    assert.deepEqual(owner.modals, []);
  } finally {
    owner.dispose();
  }
});

for (const boundary of ['dialog', 'task', 'project', 'run', 'epoch', 'worktree', 'connection']) {
  for (const outcome of ['success', 'failure']) {
    test(`file browse ${outcome} cannot cross the ${boundary} boundary or clear a newer busy state`, async () => {
      const reads = [];
      const owner = outputOwner((method) => {
        if (method === 'worker.files') {
          return Promise.resolve([]);
        }
        assert.equal(method, 'worker.browse');
        const pending = Promise.withResolvers();
        reads.push(pending);
        return pending.promise;
      });
      try {
        const previous = owner.output.browseFiles();
        if (boundary === 'dialog') {
          owner.setModal('settings');
          owner.setModal('');
        } else if (boundary === 'task') {
          owner.setTask(worker({ id: 'other_worker' }));
          owner.setTask(worker());
        } else if (boundary === 'project') {
          owner.setProject({ ...project, root: '/replacement-project' });
          owner.setProject(project);
        } else if (boundary === 'run') {
          owner.setTask(worker({ runId: 'replacement_run' }));
          owner.setTask(worker());
        } else if (boundary === 'epoch') {
          owner.setTask(
            worker({
              control: {
                version: 1,
                mode: 'fresh',
                epoch: 2,
                at: 1,
                operationId: 'fresh_operation',
                reason: 'Replaced task',
                retiredExchanges: [],
              },
            }),
          );
          owner.setTask(worker());
        } else if (boundary === 'worktree') {
          owner.setTask(worker({ worktree: { root: '/isolated', branch: 'task', baseCommit: 'base' } }));
          owner.setTask(worker());
        } else {
          owner.setConnected(false);
          owner.setConnected(true);
        }
        assert.equal(owner.output.browsing(), false);
        const current = owner.output.browseFiles();
        assert.equal(owner.output.browsing(), true);
        if (outcome === 'failure') {
          reads[0].reject(new Error('Retired browse failed.'));
        } else {
          reads[0].resolve({ root: '/project', files: ['stale.ts'] });
        }
        await previous;
        assert.equal(owner.output.browsing(), true);
        assert.equal(owner.output.fileLibrary(), undefined);
        assert.deepEqual(owner.modals, []);
        assert.deepEqual(owner.notices, []);
        reads[1].resolve({ root: '/project', files: ['current.ts'] });
        await current;
        assert.equal(owner.output.browsing(), false);
        assert.deepEqual(owner.output.fileLibrary(), { workerId: 'worker_1', files: ['current.ts'] });
        assert.deepEqual(owner.modals, ['files']);
      } finally {
        owner.dispose();
      }
    });
  }
}

test('file browsing preserves a replacement dialog and permits retry after a current failure', async () => {
  const reads = [];
  const owner = outputOwner((method) => {
    if (method === 'worker.files') {
      return Promise.resolve([]);
    }
    const pending = Promise.withResolvers();
    reads.push(pending);
    return pending.promise;
  });
  try {
    const previous = owner.output.browseFiles();
    owner.setModal('settings');
    reads[0].resolve({ root: '/project', files: ['stale.ts'] });
    await previous;
    assert.equal(owner.modal(), 'settings');
    assert.equal(owner.output.browsing(), false);
    assert.equal(owner.output.fileLibrary(), undefined);
    owner.setModal('');
    const failing = owner.output.browseFiles();
    reads[1].reject(new Error('Files are unavailable. Try again.'));
    await failing;
    assert.equal(owner.output.browsing(), false);
    assert.deepEqual(owner.notices, ['Files are unavailable. Try again.']);
    const retry = owner.output.browseFiles();
    owner.setTask(worker({ state: 'executing' }));
    owner.setProject({ ...project, revision: 2 });
    assert.equal(
      owner.output.browsing(),
      true,
      'Routine task/project snapshots retain current browse ownership.',
    );
    reads[2].resolve({ root: '/project', files: ['current.ts'] });
    await retry;
    assert.equal(owner.modal(), 'files');
    assert.equal(owner.output.browsing(), false);
  } finally {
    owner.dispose();
  }
});

test('installed file lists retain their task and reset invalidates rows, menu actions, and the files dialog', async () => {
  const owner = outputOwner(async (method, params) => {
    if (method === 'worker.files') {
      return [];
    }

    assert.equal(method, 'worker.browse');
    return { root: '/project', files: [params.workerId + '.ts'] };
  });

  try {
    await owner.output.browseFiles();
    const listing = owner.output.fileLibrary();
    assert.ok(listing);
    assert.equal(listing.workerId, 'worker_1');
    assert.equal(owner.modal(), 'files');
    const staleMenu = owner.output.fileMenu(listing.workerId, listing.files[0]);
    owner.output.previewListedFile(listing, 'not-listed.ts');
    assert.equal(owner.output.file(), '');

    batch(() => {
      owner.setTask(worker({ id: 'worker_2' }));
      owner.output.reset();
    });
    assert.equal(owner.output.fileLibrary(), undefined);
    assert.equal(owner.modal(), '');
    owner.output.previewListedFile(listing, 'worker_1.ts');
    assert.equal(owner.output.file(), '');

    await owner.output.browseFiles();
    const replacement = owner.output.fileLibrary();
    assert.ok(replacement);
    assert.equal(replacement.workerId, 'worker_2');
    owner.output.previewListedFile(listing, 'worker_1.ts');
    assert.equal(owner.modal(), 'files');
    assert.equal(owner.output.file(), '');

    owner.setTask(worker());
    for (const item of staleMenu) {
      assert.equal(typeof item.run, 'function');
      await item.run();
    }
    assert.deepEqual(owner.actions, []);
    assert.deepEqual(owner.copies, []);
    assert.equal(owner.output.file(), '');

    owner.setModal('context');
    owner.output.reset();
    assert.equal(owner.output.fileLibrary(), undefined);
    assert.equal(owner.modal(), 'context');
  } finally {
    owner.dispose();
  }
});

for (const recovery of ['reopening activity', 'reconnecting']) {
  test(
    'failed first history page can recover by ' + recovery + ' without an automatic retry loop',
    async () => {
      const pages = [];
      const owner = outputOwner((method) => {
        if (method === 'worker.files') {
          return Promise.resolve([]);
        }

        const pending = Promise.withResolvers();
        pages.push(pending);
        return pending.promise;
      });

      try {
        owner.output.setView('activity');
        pages[0].reject(new Error('First page unavailable.'));
        await flush();
        assert.equal(pages.length, 1);
        assert.equal(owner.output.historyBusy(), false);
        assert.equal(owner.output.historyError(), 'First page unavailable.');
        assert.deepEqual(owner.notices, []);

        if (recovery === 'reopening activity') {
          owner.output.setView('result');
          owner.output.setView('activity');
        } else {
          owner.setConnected(false);
          owner.setConnected(true);
        }

        assert.equal(pages.length, 2);
        pages[1].resolve({ events: [event(1, 'Recovered history')], hasMore: false, before: null });
        await flush();
        assert.deepEqual(
          owner.output.activity().map((item) => item.message),
          ['Recovered history'],
        );
        assert.equal(owner.output.historyBusy(), false);
      } finally {
        owner.dispose();
      }
    },
  );
}

test('disconnect fences an unfinished first history page and its late failure cannot unlock the new latch', async () => {
  const pages = [];
  const owner = outputOwner((method) => {
    if (method === 'worker.files') {
      return Promise.resolve([]);
    }

    const pending = Promise.withResolvers();
    pages.push(pending);
    return pending.promise;
  });

  try {
    owner.output.setView('activity');
    owner.setConnected(false);
    assert.equal(owner.output.historyBusy(), false);
    owner.setConnected(true);
    assert.equal(pages.length, 2);
    pages[0].reject(new Error('Old connection failed.'));
    await flush();
    assert.equal(owner.output.historyBusy(), true);
    assert.deepEqual(owner.notices, []);
    pages[1].resolve({ events: [event(1, 'Current connection')], hasMore: false, before: null });
    await flush();
    owner.output.setView('result');
    owner.output.setView('activity');
    assert.equal(pages.length, 2);
    assert.deepEqual(
      owner.output.activity().map((item) => item.message),
      ['Current connection'],
    );
  } finally {
    owner.dispose();
  }
});

test('output reads validate serialized file rows before exposing them to native views', async () => {
  const owner = outputOwner(async () => [{ path: 'invalid.ts', status: 'changed', bytes: -1 }]);

  try {
    await flush();
    assert.deepEqual(owner.output.files(), []);
    assert.ok(owner.output.filesError());
    assert.deepEqual(owner.notices, []);
  } finally {
    owner.dispose();
  }
});

test('file menu actions retain their task/path arguments and preview switches the existing editor view', async () => {
  const owner = outputOwner(async () => []);

  try {
    owner.output.setView('team');
    const menu = owner.output.fileMenu('worker_1', 'src/main.ts');
    assert.deepEqual(
      menu.map((item) => item.id),
      ['preview', 'window', 'finder', 'vscode', 'copy'],
    );

    for (const id of ['preview', 'finder', 'vscode', 'copy']) {
      const item = menu.find((candidate) => candidate.id === id);
      assert.ok(item);
      assert.equal(typeof item.run, 'function');
      await item.run();
    }

    assert.equal(owner.output.view(), 'result');
    assert.equal(owner.output.file(), 'src/main.ts');
    assert.deepEqual(
      owner.actions,
      ['finder', 'vscode'].map((application) => ({
        method: 'worker.openFile',
        params: { workerId: 'worker_1', path: 'src/main.ts', application },
      })),
    );
    assert.deepEqual(owner.copies, ['src/main.ts']);
  } finally {
    owner.dispose();
  }
});

test('workspace tabs own library scope and captured rename targets without injected draft setters', (context) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  // No popup is mounted; dismissal only needs a stable key for the shared registry.
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() });
  context.after(() => {
    if (previousDocument) {
      Object.defineProperty(globalThis, 'document', previousDocument);
    } else {
      delete globalThis.document;
    }
  });
  const modals = [];
  const forms = [];
  const owner = createRoot((dispose) => {
    const tabs = createWorkspaceTabs({
      snapshot: () => snapshot(),
      navigation: () => emptyWorkspace(),
      connected: () => true,
      bridges: () => [],
      projectWorkers: () => [worker()],
      toasts: new ToastCenter(),
      rpc: async () => assert.fail('Opening local UI state must not send an RPC.'),
      action: async () => {},
      applyNavigation: () => {},
      setNotice: () => {},
      success: () => {},
      setModal: (modal) => modals.push(modal),
      newWorker: (id) => forms.push(id),
      setView: () => {},
      setTextValue: () => {},
    });
    return { tabs, dispose };
  });

  try {
    owner.tabs.openLibrary('tasks', 'project_1', 'active');
    assert.deepEqual(owner.tabs.library(), { view: 'tasks', scope: 'project_1', filter: 'active' });
    owner.tabs.rename('project', 'project_1');
    assert.deepEqual(owner.tabs.renameTarget(), { kind: 'project', id: 'project_1', name: 'Demo' });
    owner.tabs.rename('task', 'worker_1');
    assert.deepEqual(owner.tabs.renameTarget(), { kind: 'task', id: 'worker_1', name: 'Example task' });
    owner.tabs.rename('task', 'missing');
    assert.equal(modals.length, 3);

    const newTask = owner.tabs.menuItems('project', 'project_1').find((item) => item.id === 'new-task');
    assert.ok(newTask);
    assert.equal(typeof newTask.run, 'function');
    newTask.run();
    assert.deepEqual(forms, ['project_1']);
  } finally {
    owner.dispose();
  }
});
