import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBncrChannelPolicy } from '../src/core/policy.ts';

test('resolveBncrChannelPolicy parses requireMention from string booleans', () => {
  const enabled = resolveBncrChannelPolicy({ requireMention: 'true' });
  const disabled = resolveBncrChannelPolicy({ requireMention: 'false' });

  assert.equal(enabled.requireMention, true);
  assert.equal(disabled.requireMention, false);
});
