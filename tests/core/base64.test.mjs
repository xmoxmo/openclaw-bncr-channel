import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalizeBase64 } from '../../src/core/base64.ts';

test('canonicalizeBase64 preserves the host canonical dialect', () => {
  assert.equal(canonicalizeBase64('TWFu'), 'TWFu');
  assert.equal(canonicalizeBase64(' T W F u\n'), 'TWFu');
  assert.equal(canonicalizeBase64('TWE='), 'TWE=');
  assert.equal(canonicalizeBase64('TWE'), 'TWE=');
  assert.equal(canonicalizeBase64('TQ=='), 'TQ==');
});

test('canonicalizeBase64 rejects malformed input and nonzero pad bits', () => {
  for (const value of ['', 'TR==', 'TQ=', 'TQ===', '!!!!', 'T=Q=']) {
    assert.equal(canonicalizeBase64(value), undefined, value);
  }
});
