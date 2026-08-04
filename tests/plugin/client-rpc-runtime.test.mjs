import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrClientRpcRuntime } from '../../src/plugin/client-rpc-runtime.ts';

function createRuntime(overrides = {}) {
  const broadcastCalls = [];
  const runtime = createBncrClientRpcRuntime({
    resolvePushConnIds: () => new Set(['conn-1']),
    broadcastToConnIds: (...args) => broadcastCalls.push(args),
    now: () => 1000,
    logInfo: () => {},
    timeoutMs: 20,
    ...overrides,
  });
  return { runtime, broadcastCalls };
}

test('client RPC broadcasts request and resolves from response', async () => {
  const { runtime, broadcastCalls } = createRuntime();
  const promise = runtime.call('client.ping', { echo: true }, 'Primary');

  assert.equal(broadcastCalls.length, 1);
  const [event, payload, connIds] = broadcastCalls[0];
  assert.equal(event, 'plugin.bncr.rpc.request');
  assert.deepEqual(Array.from(connIds), ['conn-1']);
  assert.equal(payload.method, 'client.ping');
  assert.deepEqual(payload.args, { echo: true });

  let responded;
  runtime.handleResponse({
    params: {
      requestId: payload.requestId,
      ok: true,
      result: { pong: true },
    },
    respond: (_ok, value) => {
      responded = value;
    },
  });

  assert.deepEqual(await promise, {
    ok: true,
    method: 'client.ping',
    result: { pong: true },
  });
  assert.deepEqual(responded, { ok: true, consumed: true, requestId: payload.requestId });
});

test('client RPC rejects rpc errors from the client', async () => {
  const { runtime, broadcastCalls } = createRuntime();
  const promise = runtime.call('client.ping', {}, 'Primary');

  runtime.handleResponse({
    params: {
      requestId: broadcastCalls[0][1].requestId,
      ok: false,
      error: 'method not found',
    },
    respond: () => {},
  });

  await assert.rejects(promise, /method not found/);
});

test('client RPC rejects when there is no active connection', async () => {
  const { runtime } = createRuntime({ resolvePushConnIds: () => new Set() });

  await assert.rejects(
    () => runtime.call('client.ping', {}, 'Primary'),
    /no active bncr client connection/,
  );
});

test('client RPC targets a single connection to avoid duplicate side effects', async () => {
  const { runtime, broadcastCalls } = createRuntime({
    resolvePushConnIds: () => new Set(['conn-1', 'conn-2']),
  });
  const promise = runtime.call('client.mutate', {}, 'Primary');

  assert.equal(broadcastCalls.length, 1);
  assert.deepEqual(Array.from(broadcastCalls[0][2]), ['conn-1']);

  runtime.handleResponse({
    params: { requestId: broadcastCalls[0][1].requestId, ok: true, result: { done: true } },
    respond: () => {},
  });
  await promise;
});

test('client RPC rejects the request on timeout', async () => {
  const { runtime } = createRuntime({ timeoutMs: 10 });
  await assert.rejects(() => runtime.call('client.slow', {}, 'Primary'), /RPC timeout/);
});
