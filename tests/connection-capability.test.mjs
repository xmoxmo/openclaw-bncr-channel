import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCapabilitySnapshot } from '../src/core/connection-capability.ts';

test('buildCapabilitySnapshot preserves zero capability timestamps', () => {
  assert.deepEqual(
    buildCapabilitySnapshot({
      accountId: 'Primary',
      connId: 'conn-1',
      clientId: 'client-1',
      outboundReadyUntil: 0,
      preferredForOutboundUntil: 0,
    }),
    {
      outboundReadyUntil: 0,
      preferredForOutboundUntil: 0,
      inboundOnly: false,
    },
  );
});
