import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridgeRuntimeSurfaceFacade } from '../../src/plugin/bridge-runtime-surface-facade.ts';

test('bridge runtime-surface facade projects current host api contract diagnostics', () => {
  const facade = createBncrBridgeRuntimeSurfaceFacade({
    getApi: () => ({ runtime: { config: { current() {} } } }),
  });

  const diagnostics = facade.buildRuntimeSurfaceDiagnostics();
  assert.equal(typeof diagnostics, 'object');
  assert.equal(typeof diagnostics.contract, 'object');
  assert.equal(Array.isArray(diagnostics.missing), true);
});
