import assert from 'node:assert/strict';
import test from 'node:test';

import { checkBncrMessageGate } from '../../src/messaging/inbound/gate.ts';

function makeParsed(route) {
  return {
    protocolVersion: 'scene-routing-v1',
    capabilities: ['scene-routing-v1'],
    platform: route?.platform,
    groupId: route?.groupId,
    userId: route?.userId,
    clientId: 'bncr-client-1',
    isGroup: route?.groupId !== '0',
    isAdmin: false,
    route,
  };
}

function makeCfg(overrides = {}) {
  return {
    channels: {
      bncr: {
        accounts: {
          Primary: { enabled: true },
        },
        ...overrides,
      },
    },
  };
}

test('allows valid inbound when channel and account are enabled', async () => {
  const result = await checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '0', userId: '10001' }),
    cfg: makeCfg({ dmPolicy: 'open' }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: true });
});

test('blocks inbound when account is disabled', async () => {
  const result = await checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '0', userId: '10001' }),
    cfg: makeCfg({ enabled: false }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: false, reason: 'account disabled' });
});

test('blocks inbound when route is malformed', async () => {
  const result = await checkBncrMessageGate({
    parsed: {
      ...makeParsed({ platform: 'tgBot', groupId: '0', userId: '10001' }),
      route: { platform: 'tgBot', groupId: '', userId: '10001' },
    },
    cfg: makeCfg(),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: false, reason: 'invalid route' });
});

test('blocks inbound when client protocol version is outdated', async () => {
  const result = await checkBncrMessageGate({
    parsed: {
      ...makeParsed({ platform: 'tgBot', groupId: '0', userId: '10001' }),
      protocolVersion: 'legacy-v0',
    },
    cfg: makeCfg(),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: false, reason: 'client protocol outdated' });
});

test('blocks inbound when required capability is missing', async () => {
  const result = await checkBncrMessageGate({
    parsed: {
      ...makeParsed({ platform: 'tgBot', groupId: '0', userId: '10001' }),
      capabilities: [],
    },
    cfg: makeCfg(),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: false, reason: 'client protocol outdated' });
});

test('blocks inbound when required schema fields are incomplete', async () => {
  const result = await checkBncrMessageGate({
    parsed: {
      ...makeParsed({ platform: 'tgBot', groupId: '0', userId: '10001' }),
      clientId: '',
    },
    cfg: makeCfg(),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: false, reason: 'inbound schema incomplete' });
});

test('blocks inbound when group scene is missing groupId', async () => {
  const result = await checkBncrMessageGate({
    parsed: {
      ...makeParsed({ platform: 'tgBot', groupId: '', userId: '10001' }),
      isGroup: true,
      route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    },
    cfg: makeCfg(),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: false, reason: 'inbound schema incomplete' });
});

test('does not enforce legacy ingress allowlist policy anymore', async () => {
  const result = await checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '0', userId: '10001' }),
    cfg: makeCfg({ dmPolicy: 'allowlist', allowFrom: ['tgBot:other'] }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: true });
});

test('does not enforce legacy group allowlist policy anymore', async () => {
  const result = await checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '-1001', userId: '10001' }),
    cfg: makeCfg({ groupPolicy: 'disabled' }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: true });
});

test('does not enforce reserved requireMention gate yet', async () => {
  const result = await checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '-1001', userId: '10001' }),
    cfg: makeCfg({ requireMention: true, groupPolicy: 'open' }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: true });
});
