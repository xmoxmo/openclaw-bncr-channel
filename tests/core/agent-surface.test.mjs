import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeMissingPublicAgent,
  describeMissingPublicAgentFromIds,
  HOST_DEFAULT_AGENT_ID,
  hasConfiguredAgent,
  listConfiguredAgentIds,
  PUBLIC_AGENT_ID,
  resolvePublicFallbackAgent,
} from '../../src/core/agent-surface.ts';

const cfgWith = (entries) => ({ agents: { entries } });

test('listConfiguredAgentIds returns declared agent ids', () => {
  assert.deepEqual(listConfiguredAgentIds(undefined), []);
  assert.deepEqual(listConfiguredAgentIds({}), []);
  assert.deepEqual(listConfiguredAgentIds({ agents: {} }), []);
  assert.deepEqual(listConfiguredAgentIds(cfgWith(undefined)), []);
  assert.deepEqual(listConfiguredAgentIds(cfgWith(['main', 'public'])), []);
  assert.deepEqual(listConfiguredAgentIds(cfgWith('main')), []);
  assert.deepEqual(listConfiguredAgentIds(cfgWith({ main: {}, public: {} })), ['main', 'public']);
});

test('listConfiguredAgentIds drops blank keys', () => {
  assert.deepEqual(listConfiguredAgentIds(cfgWith({ main: {}, '  ': {} })), ['main']);
});

test('hasConfiguredAgent matches exact ids only', () => {
  const cfg = cfgWith({ main: {}, public: {} });
  assert.equal(hasConfiguredAgent(cfg, 'public'), true);
  assert.equal(hasConfiguredAgent(cfg, ' public '), true);
  assert.equal(hasConfiguredAgent(cfg, 'pub'), false);
  assert.equal(hasConfiguredAgent(cfg, ''), false);
  assert.equal(hasConfiguredAgent(undefined, 'public'), false);
});

test('resolvePublicFallbackAgent prefers public and otherwise keeps the serving agent', () => {
  assert.equal(
    resolvePublicFallbackAgent(cfgWith({ main: {}, public: {} }), 'main'),
    PUBLIC_AGENT_ID,
  );
  assert.equal(resolvePublicFallbackAgent(cfgWith({ main: {} }), 'main'), 'main');
  assert.equal(resolvePublicFallbackAgent({}, 'orion'), 'orion');
  assert.equal(resolvePublicFallbackAgent(undefined, 'orion'), 'orion');
});

test('describeMissingPublicAgent stays quiet when the agent list is unknown or public exists', () => {
  assert.equal(describeMissingPublicAgent(undefined), null);
  assert.equal(describeMissingPublicAgent({}), null);
  assert.equal(describeMissingPublicAgent(cfgWith(undefined)), null);
  assert.equal(describeMissingPublicAgent(cfgWith({ public: {} })), null);
});

test('describeMissingPublicAgent names the fallback behaviour and both admin commands', () => {
  const text = describeMissingPublicAgent(cfgWith({ main: {}, orion: {} }));
  assert.ok(text);
  assert.match(text, /agent public is not configured/);
  assert.match(text, /stay on the agent already serving them/);
  assert.match(text, /oc config/);
  assert.match(text, /oc autoconfig/);
});

test('describeMissingPublicAgentFromIds accepts the inbound command snapshot', () => {
  assert.equal(describeMissingPublicAgentFromIds(new Set()), null);
  assert.equal(describeMissingPublicAgentFromIds(new Set(['public'])), null);
  assert.match(describeMissingPublicAgentFromIds(new Set(['main'])), /oc autoconfig/);
});

test('host default agent id is exposed once for the fallback sites', () => {
  assert.equal(HOST_DEFAULT_AGENT_ID, 'main');
});
