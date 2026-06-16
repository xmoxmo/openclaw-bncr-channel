import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridge } from '../../src/channel.ts';

function createApiStub() {
  return {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {
      config: {
        get() {
          return {};
        },
      },
    },
  };
}

test('resolveVerifiedTarget ignores legacy stored route keys and always returns canonical key for standard to', () => {
  const bridge = createBncrBridge(createApiStub());
  bridge.canonicalAgentId = 'orion';

  const legacyGroupKey = 'agent:orion:bncr:group:tgbot:-5158699347:10001';
  bridge.sessionRoutes.set(legacyGroupKey, {
    accountId: 'Primary',
    route: { platform: 'tgBot', groupId: '-5158699347', userId: '10001' },
    updatedAt: Date.now(),
  });

  const verified = bridge.resolveVerifiedTarget('Bncr:tgBot:-5158699347:10001', 'Primary');
  assert.equal(
    verified.sessionKey,
    'agent:orion:bncr:direct:7467426f743a2d353135383639393334373a3130303031',
  );
  assert.equal(verified.displayScope, 'Bncr:tgBot:-5158699347:10001');
});
