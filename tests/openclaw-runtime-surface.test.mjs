import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOpenClawChannelRuntimeSurfaceDiagnostics } from '../src/openclaw/runtime-surface.ts';

test('buildOpenClawChannelRuntimeSurfaceDiagnostics reports present channel surfaces', () => {
  const diagnostics = buildOpenClawChannelRuntimeSurfaceDiagnostics({
    runtime: {
      channel: {
        inbound: {},
        media: {},
        reply: {},
        routing: {},
        session: {},
      },
    },
  });

  assert.deepEqual(diagnostics.channel, {
    inbound: true,
    media: true,
    reply: true,
    routing: true,
    session: true,
  });
  assert.deepEqual(diagnostics.missing, []);
});

test('buildOpenClawChannelRuntimeSurfaceDiagnostics reports missing channel surfaces', () => {
  const diagnostics = buildOpenClawChannelRuntimeSurfaceDiagnostics({
    runtime: {
      channel: {
        inbound: {},
        routing: {},
      },
    },
  });

  assert.deepEqual(diagnostics.channel, {
    inbound: true,
    media: false,
    reply: false,
    routing: true,
    session: false,
  });
  assert.deepEqual(diagnostics.missing, ['media', 'reply', 'session']);
});

test('buildOpenClawChannelRuntimeSurfaceDiagnostics tolerates missing runtime objects', () => {
  const diagnostics = buildOpenClawChannelRuntimeSurfaceDiagnostics({});

  assert.deepEqual(diagnostics.channel, {
    inbound: false,
    media: false,
    reply: false,
    routing: false,
    session: false,
  });
  assert.deepEqual(diagnostics.missing, ['inbound', 'media', 'reply', 'routing', 'session']);
});
