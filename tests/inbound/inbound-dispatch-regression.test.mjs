import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridge } from '../../src/channel.ts';
import { cleanupBridge } from '../helpers/bncr-bridge.mjs';
import { createInboundApiStub } from '../helpers/inbound-runtime.mjs';

test('handleInbound async dispatch path reaches built inbound context instead of stopping at pre-dispatch flush', async () => {
  const { api, calls } = createInboundApiStub();
  const bridge = createBncrBridge(api);
  const responses = [];

  try {
    await bridge.handleInbound({
      params: {
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        type: 'text',
        msg: 'hello inbound',
        mimeType: 'text/plain',
        msgId: 'inbound-async-1',
      },
      respond(ok, payload) {
        responses.push({ ok, payload });
      },
      client: { connId: 'conn-1' },
      context: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(responses.length, 1);
    assert.equal(responses[0].ok, true);
    assert.equal(responses[0].payload.msgId, 'inbound-async-1');
    assert.equal(calls.builtContexts.length, 1);
    assert.equal(calls.recorded.length, 1);
    assert.equal(calls.builtContexts[0].MediaType, undefined);
    assert.equal(calls.builtContexts[0].ChatType, 'direct');
    assert.deepEqual(calls.builtContexts[0].UntrustedStructuredContext, []);
  } finally {
    cleanupBridge(bridge);
  }
});
