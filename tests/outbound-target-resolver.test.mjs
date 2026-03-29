import assert from 'node:assert/strict';
import test from 'node:test';

import {
  looksLikeBncrExplicitTarget,
  resolveBncrOutboundTarget,
} from '../src/messaging/outbound/target-resolver.ts';

const routeDirect = { platform: 'tgBot', groupId: '0', userId: '6278285192' };
const routeGroup = { platform: 'tgBot', groupId: '-1001', userId: '6278285192' };

test('looksLikeBncrExplicitTarget only accepts standard Bncr target or strict sessionKey', () => {
  assert.equal(looksLikeBncrExplicitTarget('Bncr:tgBot:6278285192'), true);
  assert.equal(looksLikeBncrExplicitTarget('Bncr:tgBot:-1001:6278285192'), true);
  assert.equal(
    looksLikeBncrExplicitTarget(
      `agent:orion:bncr:direct:${Buffer.from('tgBot:0:6278285192', 'utf8').toString('hex')}`,
    ),
    true,
  );

  assert.equal(looksLikeBncrExplicitTarget('bncr:tgBot:6278285192'), false);
  assert.equal(looksLikeBncrExplicitTarget('bncr:7467426f743a303a36323738323835313932:0'), false);
  assert.equal(looksLikeBncrExplicitTarget('hello world'), false);
  assert.equal(looksLikeBncrExplicitTarget(''), false);
});

test('resolveBncrOutboundTarget resolves standard direct target', () => {
  const resolved = resolveBncrOutboundTarget({
    target: 'Bncr:tgBot:6278285192',
    accountId: 'Primary',
  });

  assert.ok(resolved);
  assert.deepEqual(resolved.route, routeDirect);
  assert.equal(resolved.displayScope, 'Bncr:tgBot:6278285192');
  assert.equal(resolved.kind, 'user');
});

test('resolveBncrOutboundTarget resolves standard group target', () => {
  const resolved = resolveBncrOutboundTarget({
    target: 'Bncr:tgBot:-1001:6278285192',
    accountId: 'Primary',
  });

  assert.ok(resolved);
  assert.deepEqual(resolved.route, routeGroup);
  assert.equal(resolved.displayScope, 'Bncr:tgBot:-1001:6278285192');
  assert.equal(resolved.kind, 'group');
});

test('resolveBncrOutboundTarget resolves strict sessionKey into standard display scope', () => {
  const resolved = resolveBncrOutboundTarget({
    target: `agent:orion:bncr:direct:${Buffer.from('tgBot:0:6278285192', 'utf8').toString('hex')}`,
    accountId: 'Primary',
  });

  assert.ok(resolved);
  assert.deepEqual(resolved.route, routeDirect);
  assert.equal(resolved.displayScope, 'Bncr:tgBot:6278285192');
  assert.equal(resolved.kind, 'user');
});

test('resolveBncrOutboundTarget can fall back to resolveRouteBySession for known alias/session input', () => {
  const resolved = resolveBncrOutboundTarget({
    target: 'some-known-session-or-alias',
    accountId: 'Primary',
    resolveRouteBySession: () => routeGroup,
  });

  assert.ok(resolved);
  assert.deepEqual(resolved.route, routeGroup);
  assert.equal(resolved.displayScope, 'Bncr:tgBot:-1001:6278285192');
  assert.equal(resolved.kind, 'group');
});

test('resolveBncrOutboundTarget rejects legacy old-format targets', () => {
  assert.equal(
    resolveBncrOutboundTarget({
      target: 'bncr:tgBot:6278285192',
      accountId: 'Primary',
    }),
    null,
  );

  assert.equal(
    resolveBncrOutboundTarget({
      target: 'bncr:7467426f743a303a36323738323835313932:0',
      accountId: 'Primary',
    }),
    null,
  );
});
