import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRouteFromDisplayScope,
  parseStrictBncrSessionKey,
  normalizeStoredSessionKey,
  buildFallbackSessionKey,
  withTaskSessionKey,
  formatDisplayScope,
  formatLegacyDisplayScope,
} from '../src/core/targets.ts';

const route = { platform: 'tgBot', groupId: '0', userId: '6278285192' };

test('parseRouteFromDisplayScope supports legacy direct display scope', () => {
  assert.deepEqual(parseRouteFromDisplayScope('bncr:tgBot:0:6278285192'), route);
});

test('parseRouteFromDisplayScope supports modern direct display scope', () => {
  assert.deepEqual(parseRouteFromDisplayScope('Bncr-tgBot:6278285192'), route);
});

test('parseRouteFromDisplayScope supports modern group display scope', () => {
  assert.deepEqual(parseRouteFromDisplayScope('Bncr-tgBot:-1001:6278285192'), {
    platform: 'tgBot',
    groupId: '-1001',
    userId: '6278285192',
  });
});

test('formatDisplayScope uses short direct form and full group form', () => {
  assert.equal(formatDisplayScope(route), 'Bncr-tgBot:6278285192');
  assert.equal(formatDisplayScope({ platform: 'tgBot', groupId: '-1001', userId: '6278285192' }), 'Bncr-tgBot:-1001:6278285192');
  assert.equal(formatDisplayScope({ platform: 'tgBot', groupId: '-1001', userId: '0' }), 'Bncr-tgBot:-1001:0');
});

test('formatLegacyDisplayScope keeps legacy bncr prefix form', () => {
  assert.equal(formatLegacyDisplayScope(route), 'bncr:tgBot:0:6278285192');
});

test('parseRouteFromDisplayScope supports g-hex scope', () => {
  const hex = Buffer.from('tgBot:0:6278285192', 'utf8').toString('hex');
  assert.deepEqual(parseRouteFromDisplayScope(`bncr:g-${hex}`), route);
});

test('parseStrictBncrSessionKey normalizes route payload to strict direct hex sessionKey', () => {
  const parsed = parseStrictBncrSessionKey('agent:main:bncr:direct:tgBot:0:6278285192');
  assert.ok(parsed);
  assert.equal(parsed.route.platform, 'tgBot');
  assert.equal(parsed.route.groupId, '0');
  assert.equal(parsed.route.userId, '6278285192');
  assert.match(parsed.sessionKey, /^agent:main:bncr:direct:[0-9a-f]+$/);
});

test('normalizeStoredSessionKey migrates legacy hex-only keys to strict keys', () => {
  const legacy = `bncr:${Buffer.from('tgBot:0:6278285192', 'utf8').toString('hex')}:0`;
  const normalized = normalizeStoredSessionKey(legacy);
  assert.ok(normalized);
  assert.equal(normalized.sessionKey, buildFallbackSessionKey(route));
  assert.deepEqual(normalized.route, route);
});

test('withTaskSessionKey appends task suffix once', () => {
  const base = buildFallbackSessionKey(route);
  assert.equal(withTaskSessionKey(base, 'review-1'), `${base}:task:review-1`);
  assert.equal(withTaskSessionKey(`${base}:task:review-1`, 'review-2'), `${base}:task:review-1`);
});
