import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBncrInboundTurnContext } from '../../src/messaging/inbound/turn-context.ts';

test('buildBncrInboundTurnContext passes canonical route fields and visible untrusted context', () => {
  const calls = [];
  const api = {
    runtime: {
      channel: {
        inbound: {
          buildContext(args) {
            calls.push(args);
            return { built: true, args };
          },
          run() {},
        },
      },
    },
  };

  const result = buildBncrInboundTurnContext({
    api,
    channelId: 'bncr',
    parsed: {
      accountId: 'Primary',
      peer: { kind: 'group', id: 'group-1' },
      clientId: 'client-1',
      msgId: 'msg-1',
      mimeType: 'image/png',
    },
    msgId: 'msg-1',
    mimeType: 'image/png',
    mediaPath: '/tmp/inbound.png',
    peer: { kind: 'group', id: 'group-1' },
    senderIdForContext: 'client-1',
    senderDisplayName: 'bncr-client',
    resolution: {
      accountId: 'Primary',
      chatType: 'group',
      route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
      resolvedRoute: {
        sessionKey: 'agent:orion:bncr:group:route',
        agentId: 'orion',
        mainSessionKey: 'agent:orion:bncr:group:main',
      },
      canonicalTo: 'Bncr:tgBot:-1001:10001',
      rawTo: 'Bncr:tgBot:-1001:10001',
      originatingTo: 'Bncr:tgBot:-1001:10001?raw',
      baseSessionKey: 'agent:orion:bncr:group:route',
      dispatchSessionKey: 'agent:orion:bncr:group:route#task',
    },
    prepared: {
      storePath: '/tmp/store.json',
      rawBody: 'hello',
      body: 'ENV:hello',
      mediaContentType: 'image/png',
      mediaPath: '/tmp/inbound.png',
    },
  });

  assert.equal(result.built, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].route, {
    agentId: 'orion',
    accountId: 'Primary',
    routeSessionKey: 'agent:orion:bncr:group:route',
    dispatchSessionKey: 'agent:orion:bncr:group:route#task',
    mainSessionKey: 'agent:orion:bncr:group:main',
  });
  assert.deepEqual(calls[0].supplemental.untrustedContext, [
    {
      label: 'Bncr inbound context',
      source: 'bncr',
      type: 'bncr.inbound_context',
      payload: {
        reply: {
          to: 'Bncr:tgBot:-1001:10001',
          originatingTo: 'Bncr:tgBot:-1001:10001?raw',
        },
        media: [{ contentType: 'image/png', kind: 'image', messageId: 'msg-1' }],
      },
    },
  ]);
  assert.equal(calls[0].extra.BncrStructuredContextFacts.route.agentId, 'orion');
});
