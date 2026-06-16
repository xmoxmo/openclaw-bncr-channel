import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBncrMessagingExplicitTargetParser,
  createBncrMessagingOutboundSessionRouteResolver,
  createBncrMessagingSessionTargetResolver,
} from '../../src/plugin/messaging.ts';

function bridge() {
  return {
    ensureCanonicalAgentId: () => 'orion',
    resolveRouteBySession: () => null,
  };
}

test('plugin messaging parseExplicitTarget falls back to main when bridge has no canonicalAgentId', () => {
  const parse = createBncrMessagingExplicitTargetParser(() => bridge());
  const result = parse({ raw: 'Bncr:tgBot:10001' });
  assert.ok(result);
  assert.equal(result.displayScope, 'Bncr:tgBot:10001');
});

test('plugin messaging resolveSessionTarget falls back to raw id when not parseable', () => {
  const resolve = createBncrMessagingSessionTargetResolver(() => bridge());
  assert.equal(
    resolve({ id: 'raw-session-key', kind: 'group', threadId: null }),
    'raw-session-key',
  );
});

test('plugin messaging resolveOutboundSessionRoute normalizes null account and thread ids', () => {
  const resolve = createBncrMessagingOutboundSessionRouteResolver(() => bridge());
  const result = resolve({
    cfg: {},
    agentId: 'orion',
    accountId: null,
    target: 'Bncr:tgBot:10001',
    threadId: null,
  });

  assert.ok(result);
  assert.equal(result.channel, 'bncr');
  assert.equal(result.accountId, undefined);
  assert.equal(result.thread, undefined);
});
