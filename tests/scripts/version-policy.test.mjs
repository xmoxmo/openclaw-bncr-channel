import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateReleaseVersionPolicy,
  validateVersionSyntax,
} from '../../scripts/version-policy.mjs';

test('development checks validate syntax without comparing npm latest', () => {
  assert.deepEqual(validateVersionSyntax('0.7.0'), {
    ok: true,
    version: '0.7.0',
  });
});

test('development checks reject invalid semver and two-digit patches', () => {
  assert.equal(validateVersionSyntax('0.7').ok, false);
  assert.deepEqual(validateVersionSyntax('0.7.10'), {
    ok: false,
    reason: 'patch version must stay within 0-9; bump minor instead',
    version: '0.7.10',
  });
});

test('release version policy accepts exactly the next valid version', () => {
  assert.deepEqual(validateReleaseVersionPolicy('0.7.0', '0.6.9'), {
    ok: true,
    mode: 'release',
    version: '0.7.0',
  });
});

test('release version policy rejects a skipped version', () => {
  const result = validateReleaseVersionPolicy('0.7.1', '0.6.9');
  assert.equal(result.ok, false);
  assert.match(result.reason, /exactly one valid step/);
});

test('release version policy rejects the current released version', () => {
  const result = validateReleaseVersionPolicy('0.7.0', '0.7.0');
  assert.equal(result.ok, false);
  assert.match(result.reason, /expected 0\.7\.1/);
});

test('release version policy rolls 0.7.9 to 0.8.0', () => {
  assert.deepEqual(validateReleaseVersionPolicy('0.8.0', '0.7.9'), {
    ok: true,
    mode: 'release',
    version: '0.8.0',
  });
});
