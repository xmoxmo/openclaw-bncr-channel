import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrTargetRuntime } from '../../src/plugin/target-runtime.ts';

function createRuntime(overrides = {}) {
  const calls = { markActivity: [], scheduleSave: 0, logInfo: [], logWarn: [], ensureArgs: [] };
  const runtime = {
    api: { runtime: { config: { current: () => ({ channels: { bncr: {} } }) } } },
    channelId: 'bncr',
    canonicalAgentId: 'orion',
    now: () => 1234,
    normalizeAccountId: (accountId) => String(accountId || '').trim(),
    sessionRoutes: new Map(),
    routeAliases: new Map(),
    lastSessionByAccount: new Map(),
    markActivity(accountId, at) {
      calls.markActivity.push([accountId, at]);
    },
    scheduleSave() {
      calls.scheduleSave += 1;
    },
    logInfo(scope, message) {
      calls.logInfo.push([scope, message]);
    },
    logWarn(scope, message) {
      calls.logWarn.push([scope, message]);
    },
    ensureCanonicalAgentId(args) {
      calls.ensureArgs.push(args);
      return 'fallback-agent';
    },
    ...overrides,
  };
  return { runtime, calls };
}

test('target runtime remembers session route and alias with normalized account id', () => {
  const { runtime, calls } = createRuntime();
  const targetRuntime = createBncrTargetRuntime(runtime);
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };

  targetRuntime.rememberSessionRoute('session-1', ' Primary ', route);

  assert.deepEqual(runtime.sessionRoutes.get('session-1'), {
    accountId: 'Primary',
    route,
    updatedAt: 1234,
  });
  assert.equal(runtime.lastSessionByAccount.get('Primary')?.sessionKey, 'session-1');
  assert.equal(calls.scheduleSave, 1);
  assert.deepEqual(calls.markActivity[0], ['Primary', 1234]);
});

test('target runtime resolves strict session route through alias fallback', () => {
  const route = { platform: 'tgBot', groupId: '0', userId: '10001' };
  const strict = 'agent:legacy:bncr:direct:7467426f743a303a3130303031';
  const { runtime } = createRuntime({
    routeAliases: new Map([
      ['Primary|tgBot|0|10001', { accountId: 'Primary', route, updatedAt: 99 }],
    ]),
  });
  const targetRuntime = createBncrTargetRuntime(runtime);

  assert.deepEqual(targetRuntime.resolveRouteBySession(strict, 'Primary'), route);
});

test('target runtime resolves verified target and falls back to ensured canonical agent id', () => {
  const { runtime, calls } = createRuntime({ canonicalAgentId: null });
  const targetRuntime = createBncrTargetRuntime(runtime);

  const verified = targetRuntime.resolveVerifiedTarget('Bncr:tgBot:10001', 'Primary');

  assert.equal(verified.displayScope, 'Bncr:tgBot:10001');
  assert.match(verified.sessionKey, /^agent:fallback-agent:bncr:direct:/);
  assert.equal(runtime.lastSessionByAccount.get('Primary')?.scope, 'Bncr:tgBot:10001');
  assert.equal(calls.scheduleSave, 1);
  assert.deepEqual(calls.ensureArgs[0], {
    cfg: { channels: { bncr: {} } },
    accountId: 'Primary',
    channelId: 'bncr',
    peer: { kind: 'direct', id: '10001' },
  });
});

test('target runtime rejects invalid target and logs warning', () => {
  const { runtime, calls } = createRuntime();
  const targetRuntime = createBncrTargetRuntime(runtime);

  assert.throws(
    () => targetRuntime.resolveVerifiedTarget('bad-target', 'Primary'),
    /bncr invalid target/,
  );
  assert.equal(calls.logWarn.length, 1);
});
