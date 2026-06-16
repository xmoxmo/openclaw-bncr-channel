import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareBncrInboundAcceptance } from '../../src/plugin/inbound-acceptance.ts';

function buildParsed(overrides = {}) {
  return {
    accountId: 'Primary',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    sessionKeyfromroute: undefined,
    route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
    text: 'hello',
    mediaBase64: '',
    mediaPathFromTransfer: '',
    msgId: 'msg-1',
    peer: { kind: 'direct', id: 'peer-1' },
    extracted: { text: 'hello', taskKey: null },
    dedupKey: 'dedup-1',
    ...overrides,
  };
}

function buildArgs(overrides = {}) {
  return {
    api: {},
    parsed: buildParsed(),
    canonicalAgentId: 'orion',
    asString: (value, fallback = '') => (typeof value === 'string' ? value : fallback),
    getRuntimeConfig: () => ({ channels: { bncr: { enabled: true } } }),
    resolveAgentRoute: () => ({
      sessionKey: 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
    }),
    buildInboundResponsePayload: (args) => args,
    markInboundDedupSeen: () => false,
    ...overrides,
  };
}

test('prepareBncrInboundAcceptance returns invalid-peer when required peer fields are missing', async () => {
  const result = await prepareBncrInboundAcceptance(
    buildArgs({ parsed: buildParsed({ platform: '', userId: '' }) }),
  );

  assert.deepEqual(result, {
    ok: false,
    status: false,
    payload: { kind: 'invalid-peer' },
  });
});

test('prepareBncrInboundAcceptance returns duplicated when dedup key was already seen', async () => {
  const result = await prepareBncrInboundAcceptance(
    buildArgs({ markInboundDedupSeen: () => true }),
  );

  assert.deepEqual(result, {
    ok: false,
    status: true,
    payload: { kind: 'duplicated', accountId: 'Primary', msgId: 'msg-1' },
  });
});

test('prepareBncrInboundAcceptance returns gate-denied when account policy blocks the inbound', async () => {
  const result = await prepareBncrInboundAcceptance(
    buildArgs({ getRuntimeConfig: () => ({ channels: { bncr: { enabled: false } } }) }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, true);
  assert.deepEqual(result.payload, {
    kind: 'gate-denied',
    accountId: 'Primary',
    msgId: 'msg-1',
    reason: 'account disabled',
  });
});

test('prepareBncrInboundAcceptance returns accepted payload with normalized session details', async () => {
  const result = await prepareBncrInboundAcceptance(buildArgs());

  assert.deepEqual(result, {
    ok: true,
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
    inboundText: 'hello',
    hasMedia: false,
  });
});
