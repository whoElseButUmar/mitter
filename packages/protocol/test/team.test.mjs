import assert from 'node:assert/strict';
import test from 'node:test';
import { ZodError } from 'zod';
import { coreRpcRegistry, parseRpcResult, teamMessageSchema } from '../src/rpc.js';

const message = {
  id: 'message_1',
  projectId: 'project_1',
  from: 'worker_1',
  message: '\ufeffliteral\r\n界 $&  ',
  time: 0,
  kind: 'message',
};

test('team messages retain literal payloads and whole timestamps including the Date-range boundary', () => {
  for (const time of [0, 1, Date.now(), 8640000000000000]) {
    const value = { ...message, time };
    assert.deepEqual(teamMessageSchema.parse(value), value);
    assert.deepEqual(parseRpcResult(coreRpcRegistry, 'worker.team', { peers: [], messages: [value] }), {
      peers: [],
      messages: [value],
    });
  }
});

test('team timestamps reject negative, fractional, unsafe, non-finite and out-of-Date-range values', () => {
  for (const time of [
    -1,
    0.5,
    8640000000000001,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_VALUE,
    NaN,
    Infinity,
    -Infinity,
    '1',
    null,
    undefined,
  ]) {
    const result = teamMessageSchema.safeParse({ ...message, time });
    assert.equal(result.success, false, String(time));
    assert.throws(
      () => parseRpcResult(coreRpcRegistry, 'worker.team', { peers: [], messages: [{ ...message, time }] }),
      (error) => {
        assert.ok(error.cause instanceof ZodError);
        assert.deepEqual(error.cause.issues[0].path, ['messages', 0, 'time']);
        return true;
      },
    );
  }
});
