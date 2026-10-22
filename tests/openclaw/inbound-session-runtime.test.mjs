import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readBncrSessionEntry,
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
    async patchSessionEntry(params) {
      calls.push(['patchSessionEntry', params]);
      return 'updated';
    },
    async getSessionEntryAsync(params) {
      calls.push(['getSessionEntryAsync', params]);
      return { sessionKey: params.sessionKey, verboseLevel: 'on' };
    },
    async readSessionUpdatedAtAsync(params) {
      calls.push(['readSessionUpdatedAtAsync', params]);
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
    assert.deepEqual(
      await readBncrSessionEntry({ storePath: '/tmp/store', sessionKey: 'agent:demo' }),
      { sessionKey: 'agent:demo', verboseLevel: 'on' },
    );
    assert.equal(
      await readBncrSessionUpdatedAt({ storePath: '/tmp/store', sessionKey: 'agent:demo' }),
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

    assert.equal(calls.length, 7);
    assert.deepEqual(calls[0], ['resolveStorePath', 'sessions.json', { agentId: 'orion' }]);
  } finally {
    restore();
  }
});

test('readBncrSessionEntry returns undefined when the async reader throws', async () => {
  const restore = setBncrInboundSessionRuntimeForTest({
    async getSessionEntryAsync() {
      throw new Error('store unavailable');
    },
  });

  try {
    assert.equal(
      await readBncrSessionEntry({ storePath: '/tmp/store', sessionKey: 'agent:demo' }),
      undefined,
    );
  } finally {
    restore();
  }
});

test('readBncrSessionUpdatedAt propagates the async reader result', async () => {
  const restore = setBncrInboundSessionRuntimeForTest({
    async readSessionUpdatedAtAsync(params) {
      assert.deepEqual(params, { storePath: '/tmp/store', sessionKey: 'agent:demo' });
      return undefined;
    },
  });

  try {
    assert.equal(
      await readBncrSessionUpdatedAt({ storePath: '/tmp/store', sessionKey: 'agent:demo' }),
      undefined,
    );
  } finally {
    restore();
  }
});
