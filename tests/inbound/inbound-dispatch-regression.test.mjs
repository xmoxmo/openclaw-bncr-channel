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
        protocolVersion: 'scene-routing-v1',
        capabilities: ['scene-routing-v1'],
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        isGroup: true,
        isAdmin: true,
        shouldRespond: true,
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
    assert.equal(calls.builtContexts[0].ChatType, 'group');
    assert.deepEqual(calls.builtContexts[0].UntrustedStructuredContext, [
      {
        label: 'Bncr inbound context',
        source: 'bncr',
        type: 'bncr.inbound_context',
        payload: {
          platform: 'bncr/tgBot',
          sender: {
            isAdmin: true,
            isOwner: true,
            isAuthorizedSender: true,
            role: 'owner',
          },
          reply: {
            to: 'Bncr:tgBot:-1001:0',
            originatingTo: 'Bncr:tgBot:-1001:10001',
          },
        },
      },
    ]);
  } finally {
    cleanupBridge(bridge);
  }
});

test('handleInbound waits for tracked session meta task before dispatching reply', async () => {
  let releaseMetaTask;
  let metaTaskResolved = false;
  const metaTask = new Promise((resolve) => {
    releaseMetaTask = () => {
      metaTaskResolved = true;
      resolve();
    };
  });

  const { api } = createInboundApiStub({
    onReplyDispatchStart() {
      assert.equal(metaTaskResolved, true);
    },
  });
  const originalRecordInboundSession = api.runtime.channel.session.recordInboundSession;
  api.runtime.channel.session.recordInboundSession = async (args) => {
    args.trackSessionMetaTask?.(metaTask);
    return originalRecordInboundSession(args);
  };

  const bridge = createBncrBridge(api);

  try {
    const pending = bridge.handleInbound({
      params: {
        accountId: 'Primary',
        protocolVersion: 'scene-routing-v1',
        capabilities: ['scene-routing-v1'],
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '10001',
        isGroup: true,
        isAdmin: true,
        shouldRespond: true,
        type: 'text',
        msg: 'hello inbound',
        mimeType: 'text/plain',
        msgId: 'inbound-meta-barrier-1',
      },
      respond() {},
      client: { connId: 'conn-1' },
      context: null,
    });

    await Promise.resolve();
    releaseMetaTask();
    await pending;
  } finally {
    cleanupBridge(bridge);
  }
});
