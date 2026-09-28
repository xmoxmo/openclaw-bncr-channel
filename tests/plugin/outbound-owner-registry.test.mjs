import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

test('outbound owner uses persisted scene agent and falls back to public', () => {
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

  bridge.sceneRegistry.delete(sceneKey);
  assert.equal(bridge.resolveOutboundAgentId(route), 'public');

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
