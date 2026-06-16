import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBncrInboundRecordUpdateLastRoute } from '../../src/messaging/inbound/last-route.ts';

test('buildBncrInboundRecordUpdateLastRoute uses inbound last-route session when main session exists', () => {
  const result = buildBncrInboundRecordUpdateLastRoute({
    channelId: 'bncr',
    peerKind: 'direct',
    senderIdForContext: 'Bncr:tgBot:10001',
    accountId: 'Primary',
    to: 'Bncr:tgBot:10001',
    resolvedRoute: {
      sessionKey: 'agent:orion:bncr:direct:7467426f743a303a3130303031:task:abc',
      mainSessionKey: 'agent:orion:bncr:direct:7467426f743a303a3130303031',
      lastRoutePolicy: 'main',
    },
    sessionKey: 'agent:orion:bncr:direct:7467426f743a303a3130303031:task:abc',
    pinnedMainDmOwner: 'telegram:10001',
  });

  assert.deepEqual(result, {
    sessionKey: 'agent:orion:bncr:direct:7467426f743a303a3130303031',
    channel: 'bncr',
    to: 'Bncr:tgBot:10001',
    accountId: 'Primary',
    mainDmOwnerPin: {
      ownerRecipient: 'telegram:10001',
      senderRecipient: 'Bncr:tgBot:10001',
    },
  });
});

test('buildBncrInboundRecordUpdateLastRoute falls back to dispatch session when main session is missing', () => {
  const sessionKey = 'agent:orion:bncr:direct:7467426f743a303a3130303031:task:abc';
  const result = buildBncrInboundRecordUpdateLastRoute({
    channelId: 'bncr',
    peerKind: 'direct',
    senderIdForContext: 'Bncr:tgBot:10001',
    accountId: 'Primary',
    to: 'Bncr:tgBot:10001',
    resolvedRoute: {
      sessionKey,
    },
    sessionKey,
    pinnedMainDmOwner: 'telegram:10001',
  });

  assert.deepEqual(result, {
    sessionKey,
    channel: 'bncr',
    to: 'Bncr:tgBot:10001',
    accountId: 'Primary',
    mainDmOwnerPin: undefined,
  });
});
