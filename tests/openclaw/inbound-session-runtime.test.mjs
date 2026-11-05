import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyBncrSessionEntryPatch,
  configureBncrInboundSessionRuntime,
  listBncrSessionEntries,
  prepareBncrSessionEntryPatch,
  readBncrSessionEntry,
  readBncrSessionUpdatedAt,
  recordBncrInboundSession,
  recordBncrSessionMetaFromInbound,
  resolveBncrInboundSessionStorePath,
  resolveBncrPinnedMainDmOwnerFromAllowlist,
  setBncrInboundSessionRuntimeForTest,
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
    async prepareSessionEntryPatch(params) {
      calls.push(['prepareSessionEntryPatch', params]);
      return 'prepared';
    },
    async applySessionEntryPatch(params) {
      calls.push(['applySessionEntryPatch', params]);
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
    async listSessionEntriesAsync(params) {
      calls.push(['listSessionEntriesAsync', params]);
      return [{ sessionKey: 'agent:demo', entry: { updatedAt: 1234 } }];
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
      await prepareBncrSessionEntryPatch({
        storePath: '/tmp/store',
        sessionKey: 'agent:demo',
        prepare: (current) => current,
      }),
      'prepared',
    );
    assert.equal(
      await applyBncrSessionEntryPatch({
        storePath: '/tmp/store',
        sessionKey: 'agent:demo',
        patch: { verboseLevel: 'on' },
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
    assert.deepEqual(await listBncrSessionEntries({ agentId: 'orion', storePath: '/tmp/store' }), [
      { sessionKey: 'agent:demo', entry: { updatedAt: 1234 } },
    ]);
    assert.equal(
      resolveBncrPinnedMainDmOwnerFromAllowlist({
        dmScope: 'main',
        allowFrom: ['10001'],
        normalizeEntry: (entry) => String(entry || '').trim(),
      }),
      '10001',
    );

    assert.equal(calls.length, 8);
    assert.deepEqual(calls[0], ['resolveStorePath', 'sessions.json', { agentId: 'orion' }]);
  } finally {
    restore();
  }
});

test('record inbound session binds to the injected host runtime', async () => {
  configureBncrInboundSessionRuntime({
    runtime: {
      channel: {
        session: {
          async recordInboundSession(params) {
            return params.sessionKey;
          },
        },
      },
    },
  });

  assert.equal(
    await recordBncrInboundSession({ storePath: '/tmp/store', sessionKey: 'agent:host' }),
    'agent:host',
  );
});

test('pinned main DM owner keeps host semantics without a broad security barrel', () => {
  const normalizeEntry = (entry) => String(entry || '').trim();
  assert.equal(
    resolveBncrPinnedMainDmOwnerFromAllowlist({
      dmScope: 'main',
      allowFrom: [' 10001 ', '10001'],
      normalizeEntry,
    }),
    '10001',
  );
  assert.equal(
    resolveBncrPinnedMainDmOwnerFromAllowlist({
      dmScope: 'main',
      allowFrom: ['*', '10001'],
      normalizeEntry,
    }),
    null,
  );
  assert.equal(
    resolveBncrPinnedMainDmOwnerFromAllowlist({
      dmScope: 'per-channel-peer',
      allowFrom: ['10001'],
      normalizeEntry,
    }),
    null,
  );
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
