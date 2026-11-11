import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrClientRpcRuntime } from '../../src/plugin/client-rpc-runtime.ts';

function createRuntime(overrides = {}) {
  const broadcastCalls = [];
  const runtime = createBncrClientRpcRuntime({
    resolvePushOwnerConnId: () => 'conn-1',
    broadcastToConnIds: (...args) => broadcastCalls.push(args),
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
    client: { connId: 'conn-1' },
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
  const successes = [];
  const { runtime, broadcastCalls } = createRuntime({
    markOutboundAckSuccess: (args) => successes.push(args),
  });
  const promise = runtime.call('client.ping', {}, 'Primary');

  runtime.handleResponse({
    client: { connId: 'conn-1' },
    params: {
      requestId: broadcastCalls[0][1].requestId,
      ok: false,
      error: 'method not found',
    },
    respond: () => {},
  });

  await assert.rejects(promise, /method not found/);
  assert.deepEqual(successes, []);
});

test('client RPC rejects when there is no active connection', async () => {
  const { runtime } = createRuntime({ resolvePushOwnerConnId: () => null });

  await assert.rejects(
    () => runtime.call('client.ping', {}, 'Primary'),
    /no active bncr client connection/,
  );
});

test('client RPC reuses the outbound owner as its single target', async () => {
  const { runtime, broadcastCalls } = createRuntime({
    resolvePushOwnerConnId: () => 'conn-best',
  });
  const promise = runtime.call('client.mutate', {}, 'Primary');

  assert.equal(broadcastCalls.length, 1);
  assert.deepEqual(Array.from(broadcastCalls[0][2]), ['conn-best']);

  runtime.handleResponse({
    client: { connId: 'conn-best' },
    params: { requestId: broadcastCalls[0][1].requestId, ok: true, result: { done: true } },
    respond: () => {},
  });
  await promise;
});

test('client RPC accepts a delivered request result after the client reconnects', async () => {
  const { runtime, broadcastCalls } = createRuntime();
  const promise = runtime.call('client.mutate', {}, 'Primary');
  const requestId = broadcastCalls[0][1].requestId;

  runtime.handleResponse({
    client: { connId: 'conn-other' },
    params: { requestId, ok: true, result: { done: true } },
    respond: () => {},
  });

  assert.deepEqual(await promise, {
    ok: true,
    method: 'client.mutate',
    result: { done: true },
  });
});

test('client RPC uses an unguessable request id instead of a predictable counter', async () => {
  const { runtime, broadcastCalls } = createRuntime();
  const first = runtime.call('client.first', {}, 'Primary');
  const second = runtime.call('client.second', {}, 'Primary');
  const firstId = broadcastCalls[0][1].requestId;
  const secondId = broadcastCalls[1][1].requestId;

  assert.match(
    firstId,
    /^rpc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.match(
    secondId,
    /^rpc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(firstId, secondId);
  runtime.shutdown();
  await Promise.all([
    assert.rejects(() => first, /RPC cancelled/),
    assert.rejects(() => second, /RPC cancelled/),
  ]);
});

test('client RPC ignores a guessed request id', async () => {
  const { runtime, broadcastCalls } = createRuntime();
  const promise = runtime.call('client.mutate', {}, 'Primary');
  const actualRequestId = broadcastCalls[0][1].requestId;
  let ignored;

  runtime.handleResponse({
    client: { connId: 'conn-other' },
    params: { requestId: 'rpc_00000000-0000-4000-8000-000000000000', ok: true, result: {} },
    respond: (_ok, value) => {
      ignored = value;
    },
  });

  assert.deepEqual(ignored, {
    ok: true,
    consumed: false,
    requestId: 'rpc_00000000-0000-4000-8000-000000000000',
  });
  assert.equal(runtime.pendingCount(), 1);

  runtime.handleResponse({
    client: { connId: 'conn-other' },
    params: { requestId: actualRequestId, ok: true, result: { done: true } },
    respond: () => {},
  });
  await promise;
});

test('client RPC clears pending state when request broadcast throws', async () => {
  const expected = new Error('broadcast failed');
  const { runtime } = createRuntime({
    broadcastToConnIds: () => {
      throw expected;
    },
  });

  await assert.rejects(() => runtime.call('client.mutate', {}, 'Primary'), expected);
  assert.equal(runtime.pendingCount(), 0);
});

test('client RPC rejects the request on timeout', async () => {
  const failures = [];
  const { runtime } = createRuntime({
    timeoutMs: 10,
    recordOutboundFailure: (args) => failures.push(args),
  });
  await assert.rejects(() => runtime.call('client.slow', {}, 'Primary'), /RPC timeout/);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].kind, 'rpc-transport-timeout');
});

test('client RPC records transport success and commits the dispatched owner', async () => {
  const commits = [];
  const successes = [];
  const { runtime, broadcastCalls } = createRuntime({
    commitOutboundOwner: (accountId, connId) => commits.push({ accountId, connId }),
    markOutboundAckSuccess: (args) => successes.push(args),
  });
  const promise = runtime.call('client.ping', {}, 'Primary');
  assert.deepEqual(commits, [{ accountId: 'Primary', connId: 'conn-1' }]);

  runtime.handleResponse({
    params: { requestId: broadcastCalls[0][1].requestId, ok: true, result: { pong: true } },
    respond() {},
  });
  await promise;
  assert.deepEqual(successes, [{ accountId: 'Primary', connId: 'conn-1' }]);
});
