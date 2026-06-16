import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBncrChannelInboundRuntime } from '../../src/messaging/inbound/runtime-compat.ts';

test('resolveBncrChannelInboundRuntime prefers runtime.channel.inbound when available', () => {
  const buildContext = () => ({ ok: true });
  const run = () => 'ran';
  const runPreparedReply = () => 'prepared';
  const dispatchReply = () => 'dispatch';

  const resolved = resolveBncrChannelInboundRuntime({
    runtime: {
      channel: {
        inbound: {
          buildContext,
          run,
          runPreparedReply,
          dispatchReply,
        },
      },
    },
  });

  assert.equal(resolved.buildContext, buildContext);
  assert.equal(resolved.run, run);
  assert.equal(resolved.runPreparedReply, runPreparedReply);
  assert.equal(resolved.dispatchReply, dispatchReply);
});

test('resolveBncrChannelInboundRuntime falls back to legacy turn runtime', () => {
  const buildContext = () => ({ ok: true });
  const run = () => 'ran';
  const runPrepared = () => 'prepared';
  const dispatchAssembled = () => 'dispatch';

  const resolved = resolveBncrChannelInboundRuntime({
    runtime: {
      channel: {
        inbound: {},
        turn: {
          buildContext,
          run,
          runPrepared,
          dispatchAssembled,
        },
      },
    },
  });

  assert.equal(resolved.buildContext, buildContext);
  assert.equal(resolved.run, run);
  assert.equal(resolved.runPreparedReply, runPrepared);
  assert.equal(resolved.dispatchReply, dispatchAssembled);
});

test('resolveBncrChannelInboundRuntime throws when neither inbound nor turn runtime exists', () => {
  assert.throws(
    () => resolveBncrChannelInboundRuntime({ runtime: { channel: {} } }),
    /OpenClaw channel inbound runtime is unavailable/,
  );
});
