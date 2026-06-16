import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRuntimeActivitySnapshot } from '../../src/runtime/status-snapshots.ts';

test('buildRuntimeActivitySnapshot preserves zero timestamp fields', () => {
  const snapshot = buildRuntimeActivitySnapshot({
    accountId: 'Primary',
    activeConnectionCount: () => 1,
    lastSessionByAccount: new Map([
      [
        'Primary',
        { sessionKey: 'agent:main:bncr:direct:deadbeef', scope: 'Bncr:tgBot:10001', updatedAt: 0 },
      ],
    ]),
    lastActivityByAccount: new Map([['Primary', 0]]),
    lastInboundByAccount: new Map([['Primary', 0]]),
    lastOutboundByAccount: new Map([['Primary', 0]]),
  });

  assert.equal(snapshot.activeConnections, 1);
  assert.deepEqual(snapshot.lastSession, {
    sessionKey: 'agent:main:bncr:direct:deadbeef',
    scope: 'Bncr:tgBot:10001',
    updatedAt: 0,
  });
  assert.equal(snapshot.lastActivityAt, 0);
  assert.equal(snapshot.lastInboundAt, 0);
  assert.equal(snapshot.lastOutboundAt, 0);
});
