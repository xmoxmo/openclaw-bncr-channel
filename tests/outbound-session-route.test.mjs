import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBncrOutboundSessionRoute } from '../src/messaging/outbound/session-route.ts';

const routeDirect = { platform: 'tgBot', groupId: '0', userId: '10001' };
const routeGroup = { platform: 'tgBot', groupId: '-1001', userId: '10001' };

const cfg = {};
const channel = 'bncr';
const agentId = 'orion';

test('resolveBncrOutboundSessionRoute returns canonical direct hex route for direct display scope', () => {
  const resolved = resolveBncrOutboundSessionRoute({
    cfg,
    channel,
    agentId,
    canonicalAgentId: agentId,
    accountId: 'Primary',
    target: 'Bncr:tgBot:10001',
  });

  assert.ok(resolved);
  assert.equal(resolved.chatType, 'direct');
  assert.equal(resolved.peer.kind, 'direct');
  assert.equal(
    resolved.sessionKey,
    `agent:${agentId}:bncr:direct:${Buffer.from('tgBot:0:10001', 'utf8').toString('hex')}`,
  );
  assert.equal(resolved.to, 'Bncr:tgBot:10001');
  assert.equal(resolved.channel, channel);
  assert.equal(resolved.accountId, 'Primary');
  assert.deepEqual(resolved.target, {
    to: 'Bncr:tgBot:10001',
    rawTo: 'Bncr:tgBot:10001',
    chatType: 'direct',
  });
});

test('resolveBncrOutboundSessionRoute returns canonical direct hex route for group display scope', () => {
  const resolved = resolveBncrOutboundSessionRoute({
    cfg,
    channel,
    agentId,
    canonicalAgentId: agentId,
    accountId: 'Primary',
    target: 'Bncr:tgBot:-1001:10001',
  });

  assert.ok(resolved);
  assert.equal(resolved.chatType, 'direct');
  assert.equal(resolved.peer.kind, 'direct');
  assert.equal(
    resolved.sessionKey,
    `agent:${agentId}:bncr:direct:${Buffer.from('tgBot:-1001:10001', 'utf8').toString('hex')}`,
  );
  assert.equal(resolved.to, 'Bncr:tgBot:-1001:10001');
  assert.equal(resolved.channel, channel);
  assert.equal(resolved.accountId, 'Primary');
  assert.deepEqual(resolved.target, {
    to: 'Bncr:tgBot:-1001:10001',
    rawTo: 'Bncr:tgBot:-1001:10001',
    chatType: 'direct',
  });
});

test('resolveBncrOutboundSessionRoute can resolve legacy/strict session input back to canonical key', () => {
  const resolved = resolveBncrOutboundSessionRoute({
    cfg,
    channel,
    agentId,
    canonicalAgentId: agentId,
    accountId: 'Primary',
    target: 'agent:main:bncr:direct:tgBot:0:10001',
    resolveRouteBySession: () => routeDirect,
  });

  assert.ok(resolved);
  assert.equal(
    resolved.sessionKey,
    `agent:${agentId}:bncr:direct:${Buffer.from('tgBot:0:10001', 'utf8').toString('hex')}`,
  );
  assert.equal(resolved.channel, channel);
  assert.equal(resolved.accountId, 'Primary');
  assert.deepEqual(resolved.target, {
    to: 'Bncr:tgBot:10001',
    rawTo: 'Bncr:tgBot:10001',
    chatType: 'direct',
  });
});

test('resolveBncrOutboundSessionRoute can use resolveRouteBySession fallback', () => {
  const resolved = resolveBncrOutboundSessionRoute({
    cfg,
    channel,
    agentId,
    canonicalAgentId: agentId,
    accountId: 'Primary',
    target: 'agent:orion:bncr:direct:7467426f743a2d313030313a3130303031',
    resolveRouteBySession: () => routeGroup,
  });

  assert.ok(resolved);
  assert.equal(
    resolved.sessionKey,
    `agent:${agentId}:bncr:direct:${Buffer.from('tgBot:-1001:10001', 'utf8').toString('hex')}`,
  );
  assert.equal(resolved.channel, channel);
  assert.equal(resolved.accountId, 'Primary');
  assert.deepEqual(resolved.target, {
    to: 'Bncr:tgBot:-1001:10001',
    rawTo: 'Bncr:tgBot:-1001:10001',
    chatType: 'direct',
  });
});

test('resolveBncrOutboundSessionRoute preserves thread route ref when threadId is provided', () => {
  const resolved = resolveBncrOutboundSessionRoute({
    cfg,
    channel,
    agentId,
    canonicalAgentId: agentId,
    accountId: 'Primary',
    target: 'Bncr:tgBot:10001',
    threadId: 'topic-123',
  });

  assert.ok(resolved);
  assert.deepEqual(resolved.thread, { id: 'topic-123' });
  assert.deepEqual(resolved.target, {
    to: 'Bncr:tgBot:10001',
    rawTo: 'Bncr:tgBot:10001',
    chatType: 'direct',
  });
});
