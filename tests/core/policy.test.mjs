import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBncrChannelPolicy, resolveBncrConfigWarnings } from '../../src/core/policy.ts';

test('resolveBncrChannelPolicy applies channel defaults', () => {
  const policy = resolveBncrChannelPolicy({});
  assert.equal(policy.enabled, true);
  assert.equal(policy.allowBridgeCall, true);
  assert.deepEqual(policy.allowFrom, []);
});

test('resolveBncrConfigWarnings reports removed legacy policy fields', () => {
  assert.deepEqual(resolveBncrConfigWarnings({}), []);
  assert.deepEqual(resolveBncrConfigWarnings({ dmPolicy: 'allowlist', groupPolicy: 'open' }), [
    'ignored legacy policy field(s): dmPolicy, groupPolicy; Bncr admission uses scene status',
  ]);
});
