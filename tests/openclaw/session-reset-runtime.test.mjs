import assert from 'node:assert/strict';
import test from 'node:test';

import { setBncrInboundSessionRuntimeForTest } from '../../src/openclaw/inbound-session-runtime.ts';
import {
  assertBncrSessionResetOwnership,
  performBncrGatewaySessionReset,
  probeBncrSessionResetRuntime,
  setBncrSessionResetRuntimeForTest,
} from '../../src/openclaw/session-reset-runtime.ts';

test('session reset ownership accepts unowned and bncr-owned channel sessions', async () => {
  for (const entry of [undefined, { pluginOwnerId: 'bncr' }]) {
    const restore = setBncrInboundSessionRuntimeForTest({
      async getSessionEntryAsync() {
        return entry;
      },
    });
    try {
      await assertBncrSessionResetOwnership({
        storePath: '/tmp/store',
        sessionKey: 'agent:orion:bncr:direct:test',
      });
    } finally {
      restore();
    }
  }
});

test('session reset ownership rejects a session owned by another plugin', async () => {
  const restore = setBncrInboundSessionRuntimeForTest({
    async getSessionEntryAsync() {
      return { pluginOwnerId: 'memory-core' };
    },
  });
  try {
    await assert.rejects(
      assertBncrSessionResetOwnership({
        storePath: '/tmp/store',
        sessionKey: 'agent:orion:bncr:direct:test',
      }),
      /owned by plugin memory-core, not bncr/,
    );
  } finally {
    restore();
  }
});

test('session reset ownership fails closed when the session row cannot be read', async () => {
  const restore = setBncrInboundSessionRuntimeForTest({
    async getSessionEntryAsync() {
      throw new Error('session store unavailable');
    },
  });
  try {
    await assert.rejects(
      assertBncrSessionResetOwnership({
        storePath: '/tmp/store',
        sessionKey: 'agent:orion:bncr:direct:test',
      }),
      /session store unavailable/,
    );
  } finally {
    restore();
  }
});

test('session reset probe resolves the host bridge without performing a reset', async () => {
  let resetCalls = 0;
  const restore = setBncrSessionResetRuntimeForTest(async () => {
    resetCalls += 1;
    return { ok: true };
  });
  try {
    assert.deepEqual(await probeBncrSessionResetRuntime(), { available: true });
    assert.equal(resetCalls, 0);
  } finally {
    restore();
  }
});

test('session reset delegates ownership to the host effect boundary as bncr', async () => {
  let received;
  const restore = setBncrSessionResetRuntimeForTest(async (params) => {
    received = params;
    return { ok: true };
  });
  try {
    assert.deepEqual(
      await performBncrGatewaySessionReset({
        key: 'agent:orion:bncr:direct:test',
        reason: 'reset',
        agentId: 'orion',
        commandSource: 'bncr:native-command',
        authorizedPluginId: 'untrusted-override',
      }),
      { ok: true },
    );
    assert.equal(received.authorizedPluginId, 'bncr');
  } finally {
    restore();
  }
});
