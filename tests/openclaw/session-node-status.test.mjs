import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBncrSessionNodeIndex,
  classifyBncrSessionEntry,
} from '../../src/openclaw/session-node-status.ts';

test('session node: a missing entry reports not exists', () => {
  assert.deepEqual(classifyBncrSessionEntry(undefined), {
    exists: false,
    archivedAt: null,
    updatedAt: null,
  });
});

test('session node: a live entry reports exists with its last write time', () => {
  assert.deepEqual(classifyBncrSessionEntry({ updatedAt: 1700 }), {
    exists: true,
    archivedAt: null,
    updatedAt: 1700,
  });
});

test('session node: an archived entry carries its archived timestamp', () => {
  assert.deepEqual(classifyBncrSessionEntry({ archivedAt: 1800, updatedAt: 1750 }), {
    exists: true,
    archivedAt: 1800,
    updatedAt: 1750,
  });
});

test('session node: the index keys every entry by sessionKey', () => {
  const index = buildBncrSessionNodeIndex([
    { sessionKey: 'agent:public:bncr:group:a', entry: { updatedAt: 1700 } },
    { sessionKey: 'agent:public:bncr:direct:b', entry: { archivedAt: 1800, updatedAt: 1750 } },
  ]);
  assert.ok(index);
  assert.deepEqual(index.get('agent:public:bncr:group:a'), {
    exists: true,
    archivedAt: null,
    updatedAt: 1700,
  });
  assert.deepEqual(index.get('agent:public:bncr:direct:b'), {
    exists: true,
    archivedAt: 1800,
    updatedAt: 1750,
  });
  assert.equal(index.get('agent:public:bncr:group:gone'), undefined);
});

test('session node: an empty listing is unknown, never every-key-missing', () => {
  // The host SDK answers an empty list both for "no sessions" and for a store
  // it could not open. Folding that into an empty index would mark every scene
  // row as missing and make them all prune candidates.
  assert.equal(buildBncrSessionNodeIndex([]), undefined);
  assert.equal(buildBncrSessionNodeIndex(undefined), undefined);
  assert.equal(buildBncrSessionNodeIndex([{ sessionKey: '', entry: { updatedAt: 1 } }]), undefined);
});
