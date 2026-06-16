import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dispatchOpenClawReplyWithBufferedBlockDispatcher,
  formatOpenClawAgentEnvelope,
  resolveOpenClawEnvelopeFormatOptions,
} from '../../src/openclaw/reply-runtime.ts';

test('reply runtime throws when reply api is unavailable', () => {
  assert.throws(() => resolveOpenClawEnvelopeFormatOptions({}, {}), /reply API is unavailable/);
});

test('reply runtime throws when expected methods are unavailable', async () => {
  const api = { runtime: { channel: { reply: {} } } };

  assert.throws(
    () => formatOpenClawAgentEnvelope(api, { channel: 'bncr', from: 'a', timestamp: 1, body: 'b' }),
    /formatAgentEnvelope API is unavailable/,
  );
  assert.throws(
    () => resolveOpenClawEnvelopeFormatOptions(api, {}),
    /resolveEnvelopeFormatOptions API is unavailable/,
  );
  await assert.rejects(
    () =>
      dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
        ctx: {},
        cfg: {},
        dispatcherOptions: { async deliver() {} },
      }),
    /dispatchReplyWithBufferedBlockDispatcher API is unavailable/,
  );
});

test('reply runtime forwards params to host reply methods', async () => {
  const calls = [];
  const api = {
    runtime: {
      channel: {
        reply: {
          resolveEnvelopeFormatOptions(cfg) {
            calls.push(['resolveEnvelopeFormatOptions', cfg]);
            return { mode: 'compact' };
          },
          formatAgentEnvelope(params) {
            calls.push(['formatAgentEnvelope', params]);
            return `ENV:${params.body}`;
          },
          async dispatchReplyWithBufferedBlockDispatcher(params) {
            calls.push(['dispatchReplyWithBufferedBlockDispatcher', params]);
            return 'ok';
          },
        },
      },
    },
  };

  assert.deepEqual(resolveOpenClawEnvelopeFormatOptions(api, { x: 1 }), { mode: 'compact' });
  assert.equal(
    formatOpenClawAgentEnvelope(api, { channel: 'bncr', from: 'a', timestamp: 1, body: 'body' }),
    'ENV:body',
  );
  assert.equal(
    await dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
      ctx: { a: 1 },
      cfg: { b: 2 },
      dispatcherOptions: { async deliver() {} },
    }),
    'ok',
  );
  assert.equal(calls.length, 3);
});
