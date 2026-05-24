import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBncrChannelPolicy, resolveBncrConfigWarnings } from '../src/core/policy.ts';

test('resolveBncrChannelPolicy parses requireMention from string booleans', () => {
  const enabled = resolveBncrChannelPolicy({ requireMention: 'true' });
  const disabled = resolveBncrChannelPolicy({ requireMention: 'false' });

  assert.equal(enabled.requireMention, true);
  assert.equal(disabled.requireMention, false);
});

test('resolveBncrConfigWarnings reports requireMention as reserved no-op', () => {
  assert.deepEqual(resolveBncrConfigWarnings({ requireMention: false }), []);
  assert.deepEqual(resolveBncrConfigWarnings({ requireMention: 'false' }), []);
  assert.deepEqual(resolveBncrConfigWarnings({ requireMention: true }), [
    'requireMention configured but not enforced yet',
  ]);
  assert.deepEqual(resolveBncrConfigWarnings({ requireMention: 'true' }), [
    'requireMention configured but not enforced yet',
  ]);
});
