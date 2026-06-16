import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOpenClawChannelRuntimeSurfaceDiagnostics,
  OPENCLAW_RUNTIME_SURFACE_CONTRACTS,
} from '../../src/openclaw/runtime-surface.ts';

function createCompleteRuntimeApi() {
  return {
    runtime: {
      config: {
        current() {},
        mutateConfigFile() {},
      },
      media: {
        loadWebMedia() {},
      },
      channel: {
        inbound: {
          buildContext() {},
          run() {},
        },
        media: {
          readRemoteMediaBuffer() {},
          saveMediaBuffer() {},
        },
        reply: {
          resolveEnvelopeFormatOptions() {},
          formatAgentEnvelope() {},
          dispatchReplyWithBufferedBlockDispatcher() {},
        },
        routing: {
          resolveAgentRoute() {},
        },
        session: {
          readSessionUpdatedAt() {},
        },
      },
    },
  };
}

test('OpenClaw runtime surface contract list has stable unique keys', () => {
  const keys = OPENCLAW_RUNTIME_SURFACE_CONTRACTS.map((spec) => spec.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes('runtime.config.current|get'));
  assert.ok(keys.includes('runtime.channel.media.readRemoteMediaBuffer'));
  assert.ok(keys.includes('runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher'));
  assert.ok(keys.includes('runtime.channel.session.readSessionUpdatedAt'));
});

test('buildOpenClawChannelRuntimeSurfaceDiagnostics reports complete host contract', () => {
  const diagnostics = buildOpenClawChannelRuntimeSurfaceDiagnostics(createCompleteRuntimeApi());

  assert.deepEqual(diagnostics.runtime, {
    config: true,
    media: true,
  });
  assert.deepEqual(diagnostics.channel, {
    inbound: true,
    media: true,
    reply: true,
    routing: true,
    session: true,
  });
  assert.deepEqual(diagnostics.channelMedia, {
    readRemoteMediaBuffer: true,
    saveMediaBuffer: true,
  });
  assert.equal(diagnostics.contract['runtime.config.current|get'], true);
  assert.equal(diagnostics.contract['runtime.media.loadWebMedia'], true);
  assert.equal(diagnostics.contract['runtime.channel.inbound.buildContext'], true);
  assert.equal(diagnostics.contract['runtime.channel.reply.formatAgentEnvelope'], true);
  assert.equal(
    diagnostics.contract['runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher'],
    true,
  );
  assert.equal(diagnostics.contract['runtime.channel.session.readSessionUpdatedAt'], true);
  assert.deepEqual(diagnostics.missing, []);
});

test('buildOpenClawChannelRuntimeSurfaceDiagnostics reports method-level host drift', () => {
  const api = createCompleteRuntimeApi();
  delete api.runtime.channel.media.readRemoteMediaBuffer;
  delete api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher;
  delete api.runtime.channel.session.readSessionUpdatedAt;

  const diagnostics = buildOpenClawChannelRuntimeSurfaceDiagnostics(api);

  assert.equal(diagnostics.channel.media, true);
  assert.equal(diagnostics.channel.reply, true);
  assert.equal(diagnostics.channel.session, true);
  assert.deepEqual(diagnostics.channelMedia, {
    readRemoteMediaBuffer: false,
    saveMediaBuffer: true,
  });
  assert.deepEqual(diagnostics.missing, [
    'runtime.channel.media.readRemoteMediaBuffer',
    'runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher',
    'runtime.channel.session.readSessionUpdatedAt',
  ]);
});

test('buildOpenClawChannelRuntimeSurfaceDiagnostics tracks parent-object contract drift separately', () => {
  const api = createCompleteRuntimeApi();
  delete api.runtime.config;
  delete api.runtime.channel.reply;

  const diagnostics = buildOpenClawChannelRuntimeSurfaceDiagnostics(api);

  assert.equal(diagnostics.runtime.config, false);
  assert.equal(diagnostics.channel.reply, false);
  assert.deepEqual(
    diagnostics.missing.filter(
      (key) => key.startsWith('runtime.config') || key.startsWith('runtime.channel.reply'),
    ),
    [
      'runtime.config',
      'runtime.config.current|get',
      'runtime.config.mutateConfigFile',
      'runtime.channel.reply',
      'runtime.channel.reply.resolveEnvelopeFormatOptions',
      'runtime.channel.reply.formatAgentEnvelope',
      'runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher',
    ],
  );
});

test('buildOpenClawChannelRuntimeSurfaceDiagnostics tolerates missing runtime objects', () => {
  const diagnostics = buildOpenClawChannelRuntimeSurfaceDiagnostics({});

  assert.deepEqual(diagnostics.runtime, {
    config: false,
    media: false,
  });
  assert.deepEqual(diagnostics.channel, {
    inbound: false,
    media: false,
    reply: false,
    routing: false,
    session: false,
  });
  assert.deepEqual(diagnostics.channelMedia, {
    readRemoteMediaBuffer: false,
    saveMediaBuffer: false,
  });
  assert.deepEqual(
    diagnostics.missing,
    OPENCLAW_RUNTIME_SURFACE_CONTRACTS.map((spec) => spec.key),
  );
});
