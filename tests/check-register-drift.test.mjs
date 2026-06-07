import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCheckRegisterDriftOptions } from '../scripts/check-register-drift.mjs';

test('parseCheckRegisterDriftOptions trims text options and keeps fallbacks for blanks', () => {
  const options = parseCheckRegisterDriftOptions([
    '--duration-sec',
    '60',
    '--interval-sec',
    '5',
    '--account-id',
    '  Secondary  ',
    '--gateway-bin',
    '  /usr/local/bin/openclaw  ',
  ]);

  assert.equal(options.durationSec, 60);
  assert.equal(options.intervalSec, 5);
  assert.equal(options.accountId, 'Secondary');
  assert.equal(options.gatewayBin, '/usr/local/bin/openclaw');

  const fallback = parseCheckRegisterDriftOptions([
    '--duration-sec',
    'bad',
    '--interval-sec',
    'NaN',
    '--account-id',
    '   ',
    '--gateway-bin',
    '',
    '--help',
  ]);

  assert.equal(fallback.durationSec, 300);
  assert.equal(fallback.intervalSec, 15);
  assert.equal(fallback.accountId, 'Primary');
  assert.equal(fallback.gatewayBin, 'openclaw');
  assert.equal(fallback.help, true);
});
