import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFallbackSessionKey,
  formatDisplayScope,
  formatTargetDisplay,
  normalizeInboundSessionKey,
  normalizeStoredSessionKey,
  parseExplicitTarget,
  parseRouteFromDisplayScope,
  parseStrictBncrSessionKey,
  withTaskSessionKey,
} from '../src/core/targets.ts';

const route = { platform: 'tgBot', groupId: '0', userId: '6278285192' };
const canonicalAgentId = 'bncr';

test('parseRouteFromDisplayScope supports standard direct display scope', () => {
  assert.deepEqual(parseRouteFromDisplayScope('Bncr:tgBot:6278285192'), route);
});

test('parseRouteFromDisplayScope supports standard group display scope', () => {
  assert.deepEqual(parseRouteFromDisplayScope('Bncr:tgBot:-1001:6278285192'), {
    platform: 'tgBot',
    groupId: '-1001',
    userId: '6278285192',
  });
});

test('parseRouteFromDisplayScope rejects old formats', () => {
  const hex = Buffer.from('tgBot:0:6278285192', 'utf8').toString('hex');
  assert.equal(parseRouteFromDisplayScope('bncr:tgBot:0:6278285192'), null);
  assert.equal(parseRouteFromDisplayScope('bncr:tgBot:6278285192'), null);
  assert.equal(parseRouteFromDisplayScope(`bncr:g-${hex}`), null);
  assert.equal(parseRouteFromDisplayScope(`bncr:${hex}:0`), null);
  assert.equal(parseRouteFromDisplayScope('Bncr-tgBot:6278285192'), null);
});

test('formatDisplayScope uses standard direct form and full group form', () => {
  assert.equal(formatDisplayScope(route), 'Bncr:tgBot:6278285192');
  assert.equal(
    formatDisplayScope({ platform: 'tgBot', groupId: '-1001', userId: '6278285192' }),
    'Bncr:tgBot:-1001:6278285192',
  );
  assert.equal(
    formatDisplayScope({ platform: 'tgBot', groupId: '-1001', userId: '0' }),
    'Bncr:tgBot:-1001:0',
  );
});

test('parseStrictBncrSessionKey parses route payload without forcing canonical main sessionKey', () => {
  const parsed = parseStrictBncrSessionKey('agent:main:bncr:direct:tgBot:0:6278285192');
  assert.ok(parsed);
  assert.equal(parsed.inputAgentId, 'main');
  assert.equal(parsed.inputKind, 'direct');
  assert.equal(parsed.route.platform, 'tgBot');
  assert.equal(parsed.route.groupId, '0');
  assert.equal(parsed.route.userId, '6278285192');
});

test('normalizeStoredSessionKey migrates legacy hex-only keys to canonical agent keys when canonicalAgentId is provided', () => {
  const legacy = `bncr:${Buffer.from('tgBot:0:6278285192', 'utf8').toString('hex')}:0`;
  const normalized = normalizeStoredSessionKey(legacy, canonicalAgentId);
  assert.ok(normalized);
  assert.equal(normalized.sessionKey, buildFallbackSessionKey(route, canonicalAgentId));
  assert.deepEqual(normalized.route, route);
});

test('normalizeStoredSessionKey keeps strict and legacy sessionKey compatibility with canonicalAgentId override', () => {
  const strict = normalizeStoredSessionKey(
    'agent:main:bncr:direct:tgBot:0:6278285192',
    canonicalAgentId,
  );
  assert.ok(strict);
  assert.equal(strict.sessionKey, buildFallbackSessionKey(route, canonicalAgentId));
  assert.deepEqual(strict.route, route);

  const directLegacy = normalizeStoredSessionKey(
    `agent:main:bncr:direct:${Buffer.from('tgBot:0:6278285192', 'utf8').toString('hex')}:0`,
    canonicalAgentId,
  );
  assert.ok(directLegacy);
  assert.equal(directLegacy.sessionKey, buildFallbackSessionKey(route, canonicalAgentId));
  assert.deepEqual(directLegacy.route, route);
});

test('normalizeInboundSessionKey rewrites inbound strict main key to canonical agent key', () => {
  const normalized = normalizeInboundSessionKey(
    'agent:main:bncr:direct:tgBot:0:6278285192',
    route,
    canonicalAgentId,
  );
  assert.equal(normalized, buildFallbackSessionKey(route, canonicalAgentId));
});

test('withTaskSessionKey appends task suffix once', () => {
  const base = buildFallbackSessionKey(route, canonicalAgentId);
  assert.equal(withTaskSessionKey(base, 'review-1'), `${base}:task:review-1`);
  assert.equal(withTaskSessionKey(`${base}:task:review-1`, 'review-2'), `${base}:task:review-1`);
});

test('parseExplicitTarget parses direct display target and keeps chatType locked direct', () => {
  const parsed = parseExplicitTarget('Bncr:tgBot:6278285192', { canonicalAgentId });
  assert.ok(parsed);
  assert.equal(parsed.source, 'display-scope');
  assert.equal(parsed.kind, 'direct');
  assert.equal(parsed.chatType, 'direct');
  assert.equal(parsed.platform, 'tgBot');
  assert.equal(parsed.userId, '6278285192');
  assert.equal(parsed.groupId, undefined);
  assert.equal(parsed.displayScope, 'Bncr:tgBot:6278285192');
  assert.equal(parsed.canonicalSessionKey, buildFallbackSessionKey(route, canonicalAgentId));
});

test('parseExplicitTarget parses group display target but keeps chatType locked direct', () => {
  const parsed = parseExplicitTarget('Bncr:tgBot:-1003776014601:6278285192', {
    canonicalAgentId,
  });
  assert.ok(parsed);
  assert.equal(parsed.source, 'display-scope');
  assert.equal(parsed.kind, 'group');
  assert.equal(parsed.chatType, 'direct');
  assert.equal(parsed.platform, 'tgBot');
  assert.equal(parsed.groupId, '-1003776014601');
  assert.equal(parsed.userId, '6278285192');
  assert.equal(parsed.displayScope, 'Bncr:tgBot:-1003776014601:6278285192');
  assert.equal(
    parsed.canonicalSessionKey,
    buildFallbackSessionKey(
      { platform: 'tgBot', groupId: '-1003776014601', userId: '6278285192' },
      canonicalAgentId,
    ),
  );
});

test('formatTargetDisplay always returns canonical Bncr display scope', () => {
  assert.equal(formatTargetDisplay(route), 'Bncr:tgBot:6278285192');
  const parsed = parseExplicitTarget('Bncr:tgBot:-1003776014601:6278285192');
  assert.ok(parsed);
  assert.equal(formatTargetDisplay(parsed), 'Bncr:tgBot:-1003776014601:6278285192');
});
