import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFileAckKey } from '../src/core/file-ack.ts';

test('buildFileAckKey preserves valid non-negative integer chunk indexes', () => {
  assert.equal(
    buildFileAckKey({ transferId: 'transfer-1', stage: 'chunk', chunkIndex: 0 }),
    'transfer-1|chunk|0',
  );
  assert.equal(
    buildFileAckKey({ transferId: 'transfer-1', stage: 'chunk', chunkIndex: 12 }),
    'transfer-1|chunk|12',
  );
});

test('buildFileAckKey maps missing invalid and non-integer chunk indexes to stage-level key', () => {
  assert.equal(buildFileAckKey({ transferId: 'transfer-1', stage: 'complete' }), 'transfer-1|complete|-');
  assert.equal(
    buildFileAckKey({ transferId: 'transfer-1', stage: 'chunk', chunkIndex: -1 }),
    'transfer-1|chunk|-',
  );
  assert.equal(
    buildFileAckKey({ transferId: 'transfer-1', stage: 'chunk', chunkIndex: 1.5 }),
    'transfer-1|chunk|-',
  );
  assert.equal(
    buildFileAckKey({ transferId: 'transfer-1', stage: 'chunk', chunkIndex: Number.NaN }),
    'transfer-1|chunk|-',
  );
});
