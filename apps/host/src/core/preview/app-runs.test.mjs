import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appRunLimits, appRunListResultSchema } from '../../../../../packages/protocol/src/rpc.js';
import { AppRuns } from './app-runs.js';

const owner = () => ({ projectId: 'project_a', name: 'App' });
const boundary = { runId: 'run_a', epoch: 0 };

test('terminal history retains live sessions, limits old output, and excludes capability paths and URL queries', () => {
  const history = new AppRuns();
  const id = 'a'.repeat(32);
  const live = history.begin(id, 'worker_1', boundary);
  history.write(live, 'x'.repeat(appRunLimits.output * 2));
  history.write(live, '\u001b[32mCompiled\u001b[0m http://localhost:8080/' + id + '/?view=customer-12\n');
  history.write(live, 'GET /calendar?meeting=customer-12 200\n');
  assert.equal(live.output.length, appRunLimits.output);
  assert.match(live.output, /Compiled http:\/\/localhost:8080\/\[session\]\//);
  assert.doesNotMatch(live.output, /customer-12|\u001b/);
  assert.ok(!live.output.includes(id));
  for (let index = 1; index <= appRunLimits.sessions + 2; index++) {
    const attempt = history.begin(index.toString(16).padStart(32, '0'), 'worker_2', boundary);
    history.finish(attempt, 'failed', 'Installation failed.');
    history.write(attempt, 'late output');
  }
  const { runs } = appRunListResultSchema.parse(history.list('project_a', owner));
  assert.equal(runs.length, appRunLimits.sessions);
  assert.equal(runs.at(-1).previewId, id);
  assert.equal(runs[0].state, 'failed');
  assert.ok(!runs[0].output.includes('late output'));
  assert.deepEqual(history.list('project_b', owner), { runs: [] });
});

test('a terminal record accepts only its own running app URL on a local preview origin', () => {
  const history = new AppRuns();
  const previewId = 'a'.repeat(32);
  const otherId = 'b'.repeat(32);
  const url = 'http://miter-' + otherId + '.localhost:4000/' + previewId + '/index.html';
  const record = history.begin(previewId, 'worker_1', boundary);
  const valid = () => appRunListResultSchema.safeParse(history.list('project_a', owner)).success;
  assert.ok(valid());
  record.url = url;
  assert.ok(!valid());
  record.state = 'running';
  assert.ok(valid());
  for (const address of [
    url + '?extra',
    url.replace('4000', '99999'),
    url.replace(previewId, otherId),
    'https://example.org/',
  ]) {
    record.url = address;
    assert.ok(!valid());
  }
  history.finish(record, 'stopped', 'App stopped.');
  assert.ok(valid());
});
