import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOpenClawChannelOutboundSessionRoute } from '../../src/openclaw/session-route-runtime.ts';

test('buildOpenClawChannelOutboundSessionRoute forwards canonical params to host builder', () => {
  const route = buildOpenClawChannelOutboundSessionRoute({
    cfg: { channels: { bncr: { enabled: true } } },
    agentId: 'orion',
    channel: 'bncr',
    accountId: 'Primary',
    peer: { kind: 'direct', id: '10001' },
    chatType: 'direct',
    from: 'Bncr:tgBot:service',
    to: 'Bncr:tgBot:0:10001',
    threadId: '123',
  });

  assert.equal(typeof route, 'object');
  assert.equal(route.channel, undefined);
  assert.equal(route.accountId, undefined);
  assert.equal(route.agentId, undefined);
  assert.equal(route.sessionKey, 'agent:orion:main');
  assert.equal(route.baseSessionKey, 'agent:orion:main');
  assert.equal(route.from, 'Bncr:tgBot:service');
  assert.equal(route.to, 'Bncr:tgBot:0:10001');
  assert.equal(route.thread, undefined);
  assert.equal(route.threadId, '123');
  assert.deepEqual(route.peer, { kind: 'direct', id: '10001' });
});
