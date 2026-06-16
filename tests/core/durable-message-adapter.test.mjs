import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFileTransferOutboxEntry,
  buildTextOutboxEntry,
} from '../../src/core/outbox-entry-builders.ts';
import {
  createBncrDurableMessageQueuedAdapter,
  createBncrDurableMessageQueuedAdapterFromBuilders,
} from '../../src/messaging/outbound/durable-message-adapter.ts';
import { resolveBncrOutboundSessionRoute } from '../../src/messaging/outbound/session-route.ts';
import { resolveBncrOutboundTarget } from '../../src/messaging/outbound/target-resolver.ts';

const route = {
  platform: 'tgBot',
  userId: '6278285192',
  groupId: '-1003776014601',
};

function textEntry(id = 'adapter-text-1') {
  return buildTextOutboxEntry({
    createMessageId: () => id,
    now: () => 1_790_001_000_000,
    normalizeAccountId: (value) => value || 'Primary',
    normalizeReplyToId: (value) => value || '',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route,
    text: 'queued through adapter',
    kind: 'final',
    replyToId: 'source-mid-adapter',
  });
}

function mediaEntry(id = 'adapter-media-1') {
  return buildFileTransferOutboxEntry({
    createMessageId: () => id,
    now: () => 1_790_001_000_000,
    normalizeAccountId: (value) => value || 'Primary',
    pushEvent: 'bncr.file.push',
    accountId: 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route,
    mediaUrl: '/tmp/adapter.png',
    text: 'adapter media',
    kind: 'final',
  });
}

test('createBncrDurableMessageQueuedAdapter maps text sends to queued receipts', async () => {
  const calls = [];
  const adapter = createBncrDurableMessageQueuedAdapter({
    now: () => 1_790_001_111_000,
    enqueueText: (ctx) => {
      calls.push(ctx);
      return textEntry();
    },
  });

  assert.equal(adapter.id, 'bncr-queued-outbox');
  assert.equal(adapter.durableFinal, undefined);
  assert.deepEqual(adapter.receive, {
    defaultAckPolicy: 'manual',
    supportedAckPolicies: ['manual'],
  });

  const result = await adapter.send.text({
    cfg: {},
    to: 'Bncr:tgBot:-1003776014601:6278285192',
    text: 'hello',
    accountId: 'Primary',
    replyToId: 'source-mid-adapter',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'hello');
  assert.equal(result.messageId, 'adapter-text-1');
  assert.equal(result.receipt.primaryPlatformMessageId, 'adapter-text-1');
  assert.equal(result.receipt.parts[0].kind, 'text');
  assert.equal(result.receipt.parts[0].replyToId, 'source-mid-adapter');
  assert.equal(result.receipt.raw[0].meta.deliveryStage, 'queued');
  assert.equal(result.receipt.raw[0].meta.finalAckManagedBy, 'bncr-outbox');
  assert.equal(result.receipt.raw[0].meta.ackSemantics, 'plugin-accepted-not-client-acked');
});

test('createBncrDurableMessageQueuedAdapter can map media sends without taking over ack/retry', async () => {
  const adapter = createBncrDurableMessageQueuedAdapter({
    enqueueText: () => textEntry('unused-text'),
    enqueueMedia: () => mediaEntry(),
  });

  const result = await adapter.send.media({
    cfg: {},
    to: 'Bncr:tgBot:-1003776014601:6278285192',
    text: 'caption',
    mediaUrl: '/tmp/adapter.png',
    accountId: 'Primary',
  });

  assert.equal(result.messageId, 'adapter-media-1');
  assert.equal(result.receipt.parts[0].kind, 'media');
  assert.equal(result.receipt.raw[0].meta.deliveryStage, 'queued');
  assert.equal(result.receipt.raw[0].meta.queue, 'bncr.outbox');
});

test('createBncrDurableMessageQueuedAdapterFromBuilders shadows text context into bncr outbox and queued receipt', async () => {
  let counter = 0;
  const adapter = createBncrDurableMessageQueuedAdapterFromBuilders({
    createMessageId: () => `shadow-text-${++counter}`,
    now: () => 1_790_002_000_000 + counter,
    normalizeAccountId: (value) => value || 'Primary',
    normalizeReplyToId: (value) => value || '',
    resolveTarget: (ctx) => {
      assert.equal(ctx.to, 'Bncr:tgBot:-1003776014601:6278285192');
      return {
        route,
        sessionKey: 'agent:orion:bncr:direct:demo',
        accountId: ctx.accountId,
      };
    },
  });

  const result = await adapter.send.text({
    cfg: {},
    to: 'Bncr:tgBot:-1003776014601:6278285192',
    text: 'shadow text',
    accountId: 'Primary',
    replyToId: 'source-shadow-text',
  });

  assert.equal(result.messageId, 'shadow-text-1');
  assert.equal(result.receipt.parts[0].kind, 'text');
  assert.equal(result.receipt.parts[0].replyToId, 'source-shadow-text');
  assert.equal(result.receipt.raw[0].meta.deliveryStage, 'queued');
  assert.equal(result.receipt.raw[0].meta.accountId, 'Primary');
  assert.deepEqual(result.receipt.raw[0].meta.route, route);
});

test('createBncrDurableMessageQueuedAdapterFromBuilders shadows media context into file-transfer outbox and queued receipt', async () => {
  const adapter = createBncrDurableMessageQueuedAdapterFromBuilders({
    createMessageId: () => 'shadow-media-1',
    now: () => 1_790_002_123_000,
    normalizeAccountId: (value) => value || 'Primary',
    normalizeReplyToId: (value) => value || '',
    filePushEvent: 'bncr.file.push',
    resolveTarget: () => ({
      route,
      sessionKey: 'agent:orion:bncr:direct:demo',
      accountId: 'Primary',
    }),
  });

  const result = await adapter.send.media({
    cfg: {},
    to: 'Bncr:tgBot:-1003776014601:6278285192',
    text: 'shadow media',
    mediaUrl: '/tmp/shadow.png',
    mediaLocalRoots: ['/tmp'],
    accountId: 'Primary',
    replyToId: 'source-shadow-media',
  });

  assert.equal(result.messageId, 'shadow-media-1');
  assert.equal(result.receipt.parts[0].kind, 'media');
  assert.equal(result.receipt.parts[0].replyToId, 'source-shadow-media');
  assert.equal(result.receipt.raw[0].meta.deliveryStage, 'queued');
  assert.equal(result.receipt.raw[0].meta.queue, 'bncr.outbox');
});

test('createBncrDurableMessageQueuedAdapterFromBuilders shadows standard target through real bncr resolvers', async () => {
  const adapter = createBncrDurableMessageQueuedAdapterFromBuilders({
    createMessageId: () => 'shadow-real-resolver-1',
    now: () => 1_790_004_000_000,
    normalizeAccountId: (value) => value || 'Primary',
    normalizeReplyToId: (value) => value || '',
    resolveTarget: (ctx) => {
      const target = resolveBncrOutboundTarget({ target: ctx.to, accountId: ctx.accountId });
      assert.ok(target);
      const sessionRoute = resolveBncrOutboundSessionRoute({
        cfg: {},
        channel: 'bncr',
        agentId: 'orion',
        canonicalAgentId: 'orion',
        accountId: ctx.accountId,
        target: ctx.to,
      });
      assert.ok(sessionRoute);
      assert.equal(sessionRoute.target.to, 'Bncr:tgBot:-1003776014601:6278285192');
      return {
        route: target.route,
        sessionKey: sessionRoute.sessionKey,
        accountId: sessionRoute.accountId,
      };
    },
  });

  const result = await adapter.send.text({
    cfg: {},
    to: 'Bncr:tgBot:-1003776014601:6278285192',
    text: 'shadow through real resolver',
    accountId: 'Primary',
  });

  assert.equal(result.messageId, 'shadow-real-resolver-1');
  assert.deepEqual(result.receipt.raw[0].meta.route, route);
  assert.equal(
    result.receipt.raw[0].meta.sessionKey,
    'agent:orion:bncr:direct:7467426f743a2d313030333737363031343630313a36323738323835313932',
  );
  assert.equal(result.receipt.raw[0].meta.deliveryStage, 'queued');
});

test('createBncrDurableMessageQueuedAdapter can map explicitly wired payload sends to queued receipts', async () => {
  const calls = [];
  const adapter = createBncrDurableMessageQueuedAdapter({
    enqueueText: () => textEntry('unused-text'),
    enqueuePayload: (ctx) => {
      calls.push(ctx);
      return textEntry('adapter-payload-1');
    },
  });

  const result = await adapter.send.payload({
    cfg: {},
    to: 'Bncr:tgBot:-1003776014601:6278285192',
    payload: { type: 'custom-test-payload', text: 'payload text' },
    accountId: 'Primary',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.type, 'custom-test-payload');
  assert.equal(result.messageId, 'adapter-payload-1');
  assert.equal(result.receipt.parts[0].kind, 'text');
  assert.equal(result.receipt.raw[0].meta.deliveryStage, 'queued');
  assert.equal(result.receipt.raw[0].meta.finalAckManagedBy, 'bncr-outbox');
  assert.equal(result.receipt.raw[0].meta.ackSemantics, 'plugin-accepted-not-client-acked');
});

test('createBncrDurableMessageQueuedAdapter propagates enqueue failures instead of claiming queued handoff', async () => {
  const adapter = createBncrDurableMessageQueuedAdapter({
    enqueueText: () => {
      throw new Error('bncr outbox unavailable');
    },
  });

  await assert.rejects(
    () =>
      adapter.send.text({
        cfg: {},
        to: 'Bncr:tgBot:-1003776014601:6278285192',
        text: 'must not be acknowledged',
        accountId: 'Primary',
      }),
    /bncr outbox unavailable/,
  );
});

test('createBncrDurableMessageQueuedAdapter propagates payload enqueue failures instead of claiming queued handoff', async () => {
  const adapter = createBncrDurableMessageQueuedAdapter({
    enqueueText: () => textEntry('unused-text'),
    enqueuePayload: () => {
      throw new Error('bncr payload outbox unavailable');
    },
  });

  await assert.rejects(
    () =>
      adapter.send.payload({
        cfg: {},
        to: 'Bncr:tgBot:-1003776014601:6278285192',
        payload: { type: 'custom-test-payload' },
        accountId: 'Primary',
      }),
    /bncr payload outbox unavailable/,
  );
});

test('createBncrDurableMessageQueuedAdapterFromBuilders rejects legacy target formats through real resolvers before queued handoff', async () => {
  const adapter = createBncrDurableMessageQueuedAdapterFromBuilders({
    createMessageId: () => 'must-not-queue-legacy-target',
    now: () => 1_790_004_111_000,
    normalizeAccountId: (value) => value || 'Primary',
    normalizeReplyToId: (value) => value || '',
    resolveTarget: (ctx) => {
      const target = resolveBncrOutboundTarget({ target: ctx.to, accountId: ctx.accountId });
      if (!target) throw new Error('cannot resolve bncr target for durable handoff');
      const sessionRoute = resolveBncrOutboundSessionRoute({
        cfg: {},
        channel: 'bncr',
        agentId: 'orion',
        canonicalAgentId: 'orion',
        accountId: ctx.accountId,
        target: ctx.to,
      });
      if (!sessionRoute) throw new Error('cannot resolve bncr session route for durable handoff');
      return {
        route: target.route,
        sessionKey: sessionRoute.sessionKey,
        accountId: sessionRoute.accountId,
      };
    },
  });

  await assert.rejects(
    () =>
      adapter.send.text({
        cfg: {},
        to: 'bncr:tgBot:6278285192',
        text: 'legacy target must not be queued',
        accountId: 'Primary',
      }),
    /cannot resolve bncr target for durable handoff/,
  );
});

test('createBncrDurableMessageQueuedAdapterFromBuilders propagates target resolution failures before queued handoff', async () => {
  const adapter = createBncrDurableMessageQueuedAdapterFromBuilders({
    createMessageId: () => 'must-not-be-created',
    now: () => 1_790_002_999_000,
    normalizeAccountId: (value) => value || 'Primary',
    normalizeReplyToId: (value) => value || '',
    resolveTarget: () => {
      throw new Error('cannot resolve bncr target');
    },
  });

  await assert.rejects(
    () =>
      adapter.send.text({
        cfg: {},
        to: 'Bncr:unknown',
        text: 'must not be queued',
        accountId: 'Primary',
      }),
    /cannot resolve bncr target/,
  );
});

test('createBncrDurableMessageQueuedAdapterFromBuilders does not invent a payload sender', () => {
  const adapter = createBncrDurableMessageQueuedAdapterFromBuilders({
    createMessageId: () => 'shadow-text-only',
    now: () => 1_790_003_000_000,
    normalizeAccountId: (value) => value || 'Primary',
    normalizeReplyToId: (value) => value || '',
    resolveTarget: () => ({
      route,
      sessionKey: 'agent:orion:bncr:direct:demo',
      accountId: 'Primary',
    }),
  });

  assert.equal(adapter.send.payload, undefined);
  assert.equal(adapter.durableFinal, undefined);
});

test('createBncrDurableMessageQueuedAdapter leaves media/payload senders undefined until explicitly wired', () => {
  const adapter = createBncrDurableMessageQueuedAdapter({
    enqueueText: () => textEntry(),
  });

  assert.equal(adapter.send.media, undefined);
  assert.equal(adapter.send.payload, undefined);
  assert.equal(adapter.send.poll, undefined);
  assert.equal(adapter.durableFinal, undefined);
});
