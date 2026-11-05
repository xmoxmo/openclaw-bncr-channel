import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBncrSceneAgentScope } from '../../src/messaging/inbound/scene-agent-scope.ts';

const row = (agentId) => ({ sceneKey: 'tgBot:10001', agentId });

test('admin scope keeps omitted-agent fan-out and explicit-agent narrowing', () => {
  const rows = [row('main'), row('orion')];
  const all = resolveBncrSceneAgentScope({ rows, isAdmin: true });
  assert.equal(all.ok, true);
  assert.deepEqual(all.targets, rows);

  const one = resolveBncrSceneAgentScope({
    rows,
    isAdmin: true,
    requestedAgentId: 'orion',
  });
  assert.equal(one.ok, true);
  assert.deepEqual(one.targets, [rows[1]]);
});

test('non-admin omitted agent resolves only to the serving agent', () => {
  const rows = [row('main'), row('orion')];
  const result = resolveBncrSceneAgentScope({
    rows,
    isAdmin: false,
    callerAgentId: 'orion',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, [rows[1]]);
});

test('non-admin explicit self still resolves only that owned row', () => {
  const rows = [row('main'), row('orion')];
  const result = resolveBncrSceneAgentScope({
    rows,
    isAdmin: false,
    callerAgentId: 'orion',
    requestedAgentId: 'orion',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, [rows[1]]);
});

test('non-admin explicit sibling and missing caller identity fail closed', () => {
  const rows = [row('main'), row('orion')];
  const sibling = resolveBncrSceneAgentScope({
    rows,
    isAdmin: false,
    callerAgentId: 'orion',
    requestedAgentId: 'main',
  });
  assert.equal(sibling.ok, false);

  const noCaller = resolveBncrSceneAgentScope({ rows, isAdmin: false });
  assert.equal(noCaller.ok, false);
});

test('legacy unowned rows are never a non-admin caller fallback', () => {
  const legacy = row(undefined);
  const result = resolveBncrSceneAgentScope({
    rows: [legacy, row('orion')],
    isAdmin: false,
    callerAgentId: 'main',
  });
  assert.equal(result.ok, false);
});

test('an owned caller row wins over a legacy row', () => {
  const legacy = row(undefined);
  const owned = row('public');
  const result = resolveBncrSceneAgentScope({
    rows: [legacy, owned],
    isAdmin: false,
    callerAgentId: 'public',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.targets, [owned]);
});
