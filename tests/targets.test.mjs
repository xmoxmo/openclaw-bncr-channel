import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRouteFromDisplayScope,
  parseStrictBncrSessionKey,
  normalizeStoredSessionKey,
  buildFallbackSessionKey,
  withTaskSessionKey,
  formatDisplayScope,
} from '../src/core/targets.ts';

const route = { platform: 'tgBot', groupId: '0', userId: '6278285192' };

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
  assert.equal(formatDisplayScope({ platform: 'tgBot', groupId: '-1001', userId: '6278285192' }), 'Bncr:tgBot:-1001:6278285192');
  assert.equal(formatDisplayScope({ platform: 'tgBot', groupId: '-1001', userId: '0' }), 'Bncr:tgBot:-1001:0');
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

test('normalizeStoredSessionKey keeps strict and legacy sessionKey compatibility independent from to format', () => {
  const strict = normalizeStoredSessionKey('agent:main:bncr:direct:tgBot:0:6278285192');
  assert.ok(strict);
  assert.equal(strict.sessionKey, buildFallbackSessionKey(route));
  assert.deepEqual(strict.route, route);

  const directLegacy = normalizeStoredSessionKey(`agent:main:bncr:direct:${Buffer.from('tgBot:0:6278285192', 'utf8').toString('hex')}:0`);
  assert.ok(directLegacy);
  assert.equal(directLegacy.sessionKey, buildFallbackSessionKey(route));
  assert.deepEqual(directLegacy.route, route);
});

test('withTaskSessionKey appends task suffix once', () => {
  const base = buildFallbackSessionKey(route);
  assert.equal(withTaskSessionKey(base, 'review-1'), `${base}:task:review-1`);
  assert.equal(withTaskSessionKey(`${base}:task:review-1`, 'review-2'), `${base}:task:review-1`);
});
