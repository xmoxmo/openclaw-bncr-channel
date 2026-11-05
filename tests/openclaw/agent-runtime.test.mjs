import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveOpenClawAgentWorkspaceDir } from '../../src/openclaw/agent-runtime.ts';

test('agent workspace runtime forwards config and agent id to the host', () => {
  const calls = [];
  const cfg = { agents: { entries: { orion: {} } } };
  const api = {
    runtime: {
      agent: {
        resolveAgentWorkspaceDir(config, agentId) {
          calls.push([config, agentId]);
          return '/workspace/orion';
        },
      },
    },
  };

  assert.equal(resolveOpenClawAgentWorkspaceDir(api, cfg, 'orion'), '/workspace/orion');
  assert.deepEqual(calls, [[cfg, 'orion']]);
});

test('agent workspace runtime rejects a missing host capability', () => {
  assert.throws(
    () => resolveOpenClawAgentWorkspaceDir({ runtime: {} }, {}, 'orion'),
    /resolveAgentWorkspaceDir API is unavailable/,
  );
});
