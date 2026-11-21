import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainRejections } from './domain-rejections.ts';

const entry = new URL('http://miter-abc.localhost:4040/cap/index.html');
const actual = 'Tool "Bench vise" is already on loan';
const action = { type: 'click', selector: '#submit' };
const expectation = { type: 'expect', selector: '#error', text: 'already on loan' };

async function check({
  status = 409,
  before = '',
  after = actual,
  error = actual,
  method = 'POST',
  url = new URL('./api/loans', entry).href,
  nativeUrl = url,
  javascript = false,
  recorded = true,
  extraMutation = false,
  contentType = 'application/json',
  assertion = expectation,
  succeeds = true,
} = {}) {
  let text = before;
  const page = { evaluate: async () => text };
  const findings = [];
  const errors = new DomainRejections(entry, true, (value) => findings.push(value));
  await errors.begin(page, action, assertion);
  const request = { method: () => method, resourceType: () => 'fetch', url: () => url };
  if (recorded) {
    errors.request(request);
  }
  if (extraMutation) {
    errors.request({ ...request });
  }
  const response = {
    status: () => status,
    url: () => url,
    request: () => request,
    headers: () => ({ 'content-type': contentType }),
    json: async () => ({ error }),
  };
  const message = {
    type: () => 'error',
    text: () => 'Failed to load resource: the server responded with a status of ' + status + ' (Conflict)',
    args: () => [],
    frame: () => null,
    worker: () => null,
    location: () => ({ url: nativeUrl }),
  };
  if (javascript) {
    message.frame = () => ({});
    message.args = () => [{}];
  }
  errors.console(message);
  errors.response(response);
  text = after;
  if (succeeds) {
    await errors.asserted(page, assertion);
  }
  errors.flush();
  return findings;
}

test('handled JSON API rejections require fresh visible server text on the immediately asserted control', async () => {
  assert.deepEqual(await check(), []);
  for (const options of [
    { before: actual },
    { after: '' },
    { after: 'Already on loan' },
    { error: 'Different conflict' },
    { method: 'GET' },
    { url: new URL('./broken.css', entry).href },
    { url: 'https://example.invalid/api/loans' },
    { status: 500 },
    { status: 403 },
    { contentType: 'text/html' },
    { recorded: false },
    { extraMutation: true },
    { assertion: { ...expectation, visible: false } },
    { assertion: { ...expectation, count: 0 } },
    { assertion: { type: 'expect', selector: '#error', focused: false } },
    { succeeds: false },
  ]) {
    const findings = await check(options);
    assert.ok(
      findings.some((item) => item.startsWith('HTTP ')),
      JSON.stringify(options),
    );
    assert.ok(
      findings.some((item) => item.startsWith('Console error:')),
      JSON.stringify(options),
    );
  }
});

test('application console messages and a different resource diagnostic still fail', async () => {
  for (const options of [{ javascript: true }, { nativeUrl: new URL('./api/other', entry).href }]) {
    const findings = await check(options);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /^Console error:/);
  }
});
