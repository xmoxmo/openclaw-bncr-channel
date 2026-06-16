import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveInboundSessionContext } from '../../src/plugin/channel-inbound-helpers.ts';

const route = { platform: 'tgBot', groupId: '-1001', userId: '10001' };

test('resolveInboundSessionContext throws when host route has empty sessionKey', () => {
  assert.throws(
    () =>
      resolveInboundSessionContext({
        cfg: {},
        accountId: 'Primary',
        peer: { kind: 'direct', id: 'peer-1' },
        route,
        canonicalAgentId: 'orion',
        text: 'hello',
        asString: (value, fallback = '') => (typeof value === 'string' ? value : fallback),
        resolveAgentRoute: () => ({ sessionKey: '   ' }),
      }),
    /empty sessionKey/,
  );
});

test('resolveInboundSessionContext appends task session key when taskKey exists', () => {
  const result = resolveInboundSessionContext({
    cfg: {},
    accountId: 'Primary',
    peer: { kind: 'direct', id: 'peer-1' },
    route,
    canonicalAgentId: 'orion',
    taskKey: 'task-42',
    text: 'hello',
    asString: (value, fallback = '') => (typeof value === 'string' ? value : fallback),
    resolveAgentRoute: () => ({
      sessionKey: 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
    }),
  });

  assert.equal(result.baseSessionKey, 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031');
  assert.equal(
    result.taskSessionKey,
    'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031:task:task-42',
  );
  assert.equal(result.sessionKey, result.taskSessionKey);
});

test('resolveInboundSessionContext prefers normalized sessionKeyFromRoute over host route sessionKey', () => {
  const result = resolveInboundSessionContext({
    cfg: {},
    accountId: 'Primary',
    peer: { kind: 'direct', id: 'peer-1' },
    route,
    sessionKeyFromRoute: 'agent:main:bncr:direct:tgBot:-1001:10001',
    canonicalAgentId: 'orion',
    text: 'hello',
    extractedText: 'trimmed',
    asString: (value, fallback = '') => (typeof value === 'string' ? value : fallback),
    resolveAgentRoute: () => ({ sessionKey: 'host-session-key' }),
  });

  assert.equal(result.baseSessionKey, 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031');
  assert.equal(result.inboundText, 'trimmed');
});
