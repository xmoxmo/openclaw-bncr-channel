import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readBncrSessionUpdatedAt,
  recordBncrInboundSession,
  recordBncrSessionMetaFromInbound,
  resolveBncrInboundSessionStorePath,
  resolveBncrPinnedMainDmOwnerFromAllowlist,
  setBncrInboundSessionRuntimeForTest,
  updateBncrSessionStoreEntry,
} from '../../src/openclaw/inbound-session-runtime.ts';

test('inbound session runtime forwards calls to injected runtime override', async () => {
  const calls = [];
  const restore = setBncrInboundSessionRuntimeForTest({
    resolveStorePath(storeConfig, options) {
      calls.push(['resolveStorePath', storeConfig, options]);
      return '/tmp/bncr-session-store.json';
    },
    async recordInboundSession(params) {
      calls.push(['recordInboundSession', params]);
      return 'recorded';
    },
    async recordSessionMetaFromInbound(params) {
      calls.push(['recordSessionMetaFromInbound', params]);
      return 'meta-recorded';
    },
    async updateSessionStoreEntry(params) {
      calls.push(['updateSessionStoreEntry', params]);
      return 'updated';
    },
    readSessionUpdatedAt(params) {
      calls.push(['readSessionUpdatedAt', params]);
      return 1234;
    },
    resolvePinnedMainDmOwnerFromAllowlist(params) {
      calls.push(['resolvePinnedMainDmOwnerFromAllowlist', params]);
      return 'owner:demo';
    },
  });

  try {
    assert.equal(
      resolveBncrInboundSessionStorePath({
        storeConfig: 'sessions.json',
        agentId: 'orion',
      }),
      '/tmp/bncr-session-store.json',
    );
    assert.equal(
      await recordBncrInboundSession({
        storePath: '/tmp/store',
        sessionKey: 'agent:demo',
        ctx: {},
      }),
      'recorded',
    );
    assert.equal(
      await recordBncrSessionMetaFromInbound({
        storePath: '/tmp/store',
        sessionKey: 'agent:demo',
        ctx: {},
      }),
      'meta-recorded',
    );
    assert.equal(
      await updateBncrSessionStoreEntry({
        storePath: '/tmp/store',
        sessionKey: 'agent:demo',
        update: (current) => current,
      }),
      'updated',
    );
    assert.equal(
      readBncrSessionUpdatedAt({}, { storePath: '/tmp/store', sessionKey: 'agent:demo' }),
      1234,
    );
    assert.equal(
      resolveBncrPinnedMainDmOwnerFromAllowlist({
        dmScope: 'main',
        allowFrom: ['10001'],
        normalizeEntry: (entry) => String(entry || '').trim(),
      }),
      'owner:demo',
    );

    assert.equal(calls.length, 6);
    assert.deepEqual(calls[0], ['resolveStorePath', 'sessions.json', { agentId: 'orion' }]);
  } finally {
    restore();
  }
});

test('readBncrSessionUpdatedAt falls back to host runtime when override does not provide reader', () => {
  const restore = setBncrInboundSessionRuntimeForTest({
    resolveStorePath() {
      return '/tmp/store';
    },
  });

  try {
    const api = {
      runtime: {
        channel: {
          session: {
            readSessionUpdatedAt(params) {
              return `${params.storePath}:${params.sessionKey}`;
            },
          },
        },
      },
    };

    assert.equal(
      readBncrSessionUpdatedAt(api, {
        storePath: '/tmp/store',
        sessionKey: 'agent:demo',
      }),
      '/tmp/store:agent:demo',
    );
  } finally {
    restore();
  }
});

test('readBncrSessionUpdatedAt throws when neither override nor host runtime provides reader', () => {
  const restore = setBncrInboundSessionRuntimeForTest({
    resolveStorePath() {
      return '/tmp/store';
    },
  });

  try {
    assert.throws(
      () =>
        readBncrSessionUpdatedAt(
          { runtime: { channel: { session: {} } } },
          { storePath: '/tmp/store', sessionKey: 'agent:demo' },
        ),
      /readSessionUpdatedAt API is unavailable/,
    );
  } finally {
    restore();
  }
});
