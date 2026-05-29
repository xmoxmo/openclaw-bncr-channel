import assert from 'node:assert/strict';
import test from 'node:test';

import { checkBncrMessageGate } from '../src/messaging/inbound/gate.ts';

function makeParsed(route) {
  return { route };
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

test('allows DM when dmPolicy=open', async () => {
  const result = await checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '0', userId: '10001' }),
    cfg: makeCfg({ dmPolicy: 'open' }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: true });
});

test('blocks DM when dmPolicy=disabled', async () => {
  const result = await checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '0', userId: '10001' }),
    cfg: makeCfg({ dmPolicy: 'disabled' }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: false, reason: 'dm disabled' });
});

test('allows DM allowlist by standard display scope', async () => {
  const result = await checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '0', userId: '10001' }),
    cfg: makeCfg({ dmPolicy: 'allowlist', allowFrom: ['Bncr:tgBot:10001'] }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: true });
});

test('blocks DM when allowlist misses', async () => {
  const result = await checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '0', userId: '10001' }),
    cfg: makeCfg({ dmPolicy: 'allowlist', allowFrom: ['tgBot:other'] }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: false, reason: 'dm allowlist blocked' });
});

test('blocks group when groupPolicy=disabled', async () => {
  const result = await checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '-1001', userId: '10001' }),
    cfg: makeCfg({ groupPolicy: 'disabled' }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: false, reason: 'group disabled' });
});

test('allows group allowlist by standard display scope', async () => {
  const result = await checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '-1001', userId: '10001' }),
    cfg: makeCfg({ groupPolicy: 'allowlist', groupAllowFrom: ['Bncr:tgBot:-1001:10001'] }),
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
