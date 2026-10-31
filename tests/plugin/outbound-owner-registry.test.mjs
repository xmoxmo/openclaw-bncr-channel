import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

test('outbound owner uses persisted scene agent, then public, then the serving agent', () => {
  const bridge = createBridge();
  const route = { platform: 'tgBot', groupId: '-5384397128', userId: '0' };
  const sceneKey = 'tgBot:-5384397128';

  bridge.sceneRegistry.set(sceneKey, {
    sceneKey,
    kind: 'group',
    status: 'allowed',
    platform: 'tgBot',
    groupId: '-5384397128',
    agentId: 'public',
    lastSeenAt: 1,
  });
  assert.equal(bridge.resolveOutboundAgentId(route), 'public');

  bridge.sceneRegistry.set(sceneKey, {
    ...bridge.sceneRegistry.get(sceneKey),
    agentId: 'orion',
  });
  assert.equal(bridge.resolveOutboundAgentId(route), 'orion');

  // The stub config declares no agents, so public is not a target this host
  // serves: an unowned route stays on the agent already handling it.
  bridge.sceneRegistry.delete(sceneKey);
  assert.equal(bridge.resolveOutboundAgentId(route), 'main');

  const directRoute = { platform: 'tgBot', groupId: '0', userId: '10001' };
  bridge.sceneRegistry.set('tgBot:10001', {
    sceneKey: 'tgBot:10001',
    kind: 'direct',
    status: 'allowed',
    platform: 'tgBot',
    userId: '10001',
    agentId: 'orion',
    lastSeenAt: 1,
  });
  assert.equal(bridge.resolveOutboundAgentId(directRoute), 'orion');

  cleanupBridge(bridge);
});

test('outbound owner falls back to public only when the host serves it', () => {
  const bridge = createBridge(null, {
    config: { agents: { entries: { public: { name: 'Public' } } } },
  });
  const route = { platform: 'tgBot', groupId: '-5384397128', userId: '0' };

  assert.equal(bridge.resolveOutboundAgentId(route), 'public');

  cleanupBridge(bridge);
});

test('outbound owner prefers the host-supplied cfg over a second live-config read', () => {
  // Live config declares no agents; the caller passes the config the host used
  // to build the route. The passed cfg must win, so no second read can disagree.
  const bridge = createBridge(null, { config: {} });
  const route = { platform: 'tgBot', groupId: '-5384397128', userId: '0' };
  const hostCfg = { agents: { entries: { public: { name: 'Public' } } } };

  assert.equal(bridge.resolveOutboundAgentId(route, hostCfg), 'public');

  cleanupBridge(bridge);
});
