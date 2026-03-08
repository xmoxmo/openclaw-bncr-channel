import test from 'node:test';
import assert from 'node:assert/strict';

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

test('allows DM when dmPolicy=open', () => {
  const result = checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '0', userId: '6278285192' }),
    cfg: makeCfg({ dmPolicy: 'open' }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: true });
});

test('blocks DM when dmPolicy=disabled', () => {
  const result = checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '0', userId: '6278285192' }),
    cfg: makeCfg({ dmPolicy: 'disabled' }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: false, reason: 'dm disabled' });
});

test('allows DM allowlist by modern display scope', () => {
  const result = checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '0', userId: '6278285192' }),
    cfg: makeCfg({ dmPolicy: 'allowlist', allowFrom: ['Bncr-tgBot:6278285192'] }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: true });
});

test('allows DM allowlist by legacy full display scope', () => {
  const result = checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '0', userId: '6278285192' }),
    cfg: makeCfg({ dmPolicy: 'allowlist', allowFrom: ['bncr:tgBot:0:6278285192'] }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: true });
});

test('allows DM allowlist by short platform:user form', () => {
  const result = checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '0', userId: '6278285192' }),
    cfg: makeCfg({ dmPolicy: 'allowlist', allowFrom: ['tgBot:6278285192'] }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: true });
});

test('blocks DM when allowlist misses', () => {
  const result = checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '0', userId: '6278285192' }),
    cfg: makeCfg({ dmPolicy: 'allowlist', allowFrom: ['tgBot:other'] }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: false, reason: 'dm allowlist blocked' });
});

test('blocks group when groupPolicy=disabled', () => {
  const result = checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '-1001', userId: '6278285192' }),
    cfg: makeCfg({ groupPolicy: 'disabled' }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: false, reason: 'group disabled' });
});

test('allows group allowlist by modern display scope', () => {
  const result = checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '-1001', userId: '6278285192' }),
    cfg: makeCfg({ groupPolicy: 'allowlist', groupAllowFrom: ['Bncr-tgBot:-1001:6278285192'] }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: true });
});

test('allows group allowlist by legacy display scope', () => {
  const result = checkBncrMessageGate({
    parsed: makeParsed({ platform: 'tgBot', groupId: '-1001', userId: '6278285192' }),
    cfg: makeCfg({ groupPolicy: 'allowlist', groupAllowFrom: ['bncr:tgBot:-1001:6278285192'] }),
    account: { accountId: 'Primary', enabled: true },
  });
  assert.deepEqual(result, { allowed: true });
});
