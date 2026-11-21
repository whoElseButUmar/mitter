import assert from 'node:assert/strict';
import test from 'node:test';
import { previewNetworkArguments } from './chrome-pipe.mjs';

test('private Chrome keeps all network blocked unless an exact owned preview is supplied', () => {
  assert.deepEqual(previewNetworkArguments(), [
    '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND',
  ]);
  const host = 'miter-' + 'a'.repeat(32) + '.localhost';
  assert.deepEqual(previewNetworkArguments(['http://' + host + ':45678']), [
    '--proxy-bypass-list=<-loopback>;' + host + ':45678',
    '--host-resolver-rules=MAP ' + host + ' 127.0.0.1, MAP * ~NOTFOUND',
  ]);
  for (const origin of [
    'http://localhost:45678',
    'http://127.0.0.1:45678',
    'https://' + host + ':45678',
    'http://' + host,
    'http://' + host + ':45678/path',
    'http://' + host + ':45678;*',
    'http://user:password@' + host + ':45678',
    'http://*.localhost:45678',
  ]) {
    assert.throws(() => previewNetworkArguments([origin]));
  }
  assert.throws(() => previewNetworkArguments(Array(5).fill('http://' + host + ':45678')));
});
