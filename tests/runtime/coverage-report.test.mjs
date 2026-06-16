import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const projectRoot = process.cwd();

test('phase coverage report records current direct and integration test focus', () => {
  const reportPath = path.join(projectRoot, 'tests', 'runtime', 'coverage-report.json');
  const persisted = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const expected = {
    phase: 'next-phase-cross-module-regressions',
    covered: {
      channelMessageToAck: true,
      inboundNativeCommandReply: true,
      targetSessionAliasRestore: true,
      deadLetterPaginationIsolation: true,
      rerouteRetryDeadLetterMatrix: true,
      fileTransferLateAckOwner: true,
      statusDiagnosticsConsistency: true,
    },
    deferred: {
      largeScaleHelperRewrite: false,
    },
  };

  assert.equal(persisted.phase, expected.phase);
  assert.deepEqual(persisted.covered, expected.covered);
  assert.deepEqual(persisted.deferred, expected.deferred);
  assert.equal(typeof persisted.updatedAt, 'string');

  if (process.env.BNCR_UPDATE_COVERAGE_REPORT === '1') {
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify({ ...expected, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
});
