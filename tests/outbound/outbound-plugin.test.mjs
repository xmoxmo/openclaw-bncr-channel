import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrOutboundRuntime } from '../../src/plugin/outbound.ts';

test('outbound replyAction drops reply target before channel text send', async () => {
  const calls = [];
  const outbound = createBncrOutboundRuntime(() => ({
    channelSendText: async (ctx) => {
      calls.push(ctx);
      return { ok: true };
    },
    channelSendMedia: async () => ({ ok: true }),
  }));

  const result = await outbound.replyAction({
    accountId: ' Primary ',
    to: ' Bncr:tgBot:-1001:0 ',
    text: ' status-like reply text ',
    replyToId: ' source-message-id ',
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    {
      accountId: 'Primary',
      to: 'Bncr:tgBot:-1001:0',
      text: ' status-like reply text ',
    },
  ]);
});
