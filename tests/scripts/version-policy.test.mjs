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
    reason: 'patch version must stay within 0-9',
    version: '0.7.10',
  });
});

test('release version policy accepts exactly the next patch version', () => {
  assert.deepEqual(validateReleaseVersionPolicy('0.8.6', '0.8.5'), {
    ok: true,
    mode: 'release',
    version: '0.8.6',
  });
});

test('release version policy rejects a skipped version', () => {
  const result = validateReleaseVersionPolicy('0.8.7', '0.8.5');
  assert.equal(result.ok, false);
  assert.match(result.reason, /exactly one version step/);
});

test('release version policy rejects the current released version', () => {
  const result = validateReleaseVersionPolicy('0.8.5', '0.8.5');
  assert.equal(result.ok, false);
  assert.match(result.reason, /expected 0\.8\.6/);
});

test('release version policy rejects minor and major rollover', () => {
  for (const version of ['0.9.0', '1.0.0']) {
    const result = validateReleaseVersionPolicy(version, '0.8.5');
    assert.equal(result.ok, false);
    assert.match(result.reason, /expected 0\.8\.6/);
  }
});

test('release version policy rolls patch nine into the next minor', () => {
  assert.deepEqual(validateReleaseVersionPolicy('0.9.0', '0.8.9'), {
    ok: true,
    mode: 'release',
    version: '0.9.0',
  });
});

test('release version policy rejects a skipped minor rollover', () => {
  const result = validateReleaseVersionPolicy('0.9.1', '0.8.9');
  assert.equal(result.ok, false);
  assert.match(result.reason, /expected 0\.9\.0/);
});

test('release version policy rejects a major rollover when minor nine is full', () => {
  const result = validateReleaseVersionPolicy('1.0.0', '0.9.9');
  assert.equal(result.ok, false);
  assert.match(result.reason, /without a major rollover/);
});
