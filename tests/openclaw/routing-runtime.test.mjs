import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveOpenClawAgentRoute,
  resolveOpenClawInboundLastRouteSessionKey,
} from '../../src/openclaw/routing-runtime.ts';

test('resolveOpenClawAgentRoute throws when routing api is unavailable', () => {
  assert.throws(
    () =>
      resolveOpenClawAgentRoute({}, { cfg: {}, channel: 'bncr', accountId: 'Primary', peer: {} }),
    /OpenClaw channel routing API is unavailable/,
  );
});

test('resolveOpenClawAgentRoute throws when resolveAgentRoute is unavailable', () => {
  assert.throws(
    () =>
      resolveOpenClawAgentRoute(
        { runtime: { channel: { routing: {} } } },
        { cfg: {}, channel: 'bncr', accountId: 'Primary', peer: {} },
      ),
    /resolveAgentRoute API is unavailable/,
  );
});

test('resolveOpenClawAgentRoute returns host route payload unchanged', () => {
  const expected = {
    sessionKey: 'agent:orion:bncr:direct:demo',
    mainSessionKey: 'agent:orion:bncr:direct:main',
    route: { userId: '10001' },
    agentId: 'orion',
    extra: true,
  };

  const actual = resolveOpenClawAgentRoute(
    {
      runtime: {
        channel: {
          routing: {
            resolveAgentRoute() {
              return expected;
            },
          },
        },
      },
    },
    { cfg: {}, channel: 'bncr', accountId: 'Primary', peer: { kind: 'direct', id: '10001' } },
  );

  assert.equal(actual, expected);
});

test('resolveOpenClawInboundLastRouteSessionKey honors main and session policies', () => {
  assert.equal(
    resolveOpenClawInboundLastRouteSessionKey({
      route: { lastRoutePolicy: 'main', mainSessionKey: 'agent:main' },
      sessionKey: 'agent:session',
    }),
    'agent:main',
  );
  assert.equal(
    resolveOpenClawInboundLastRouteSessionKey({
      route: { lastRoutePolicy: 'session', mainSessionKey: 'agent:main' },
      sessionKey: 'agent:session',
    }),
    'agent:session',
  );
});
