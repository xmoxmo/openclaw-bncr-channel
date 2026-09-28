import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBncrMessagingExplicitTargetParser,
  createBncrMessagingOutboundSessionRouteResolver,
  createBncrMessagingSessionTargetResolver,
} from '../../src/plugin/messaging.ts';

function bridge() {
  return {
    resolveOutboundAgentId: () => 'public',
    resolveRouteBySession: () => null,
  };
}

test('plugin messaging parseExplicitTarget normalizes without canonical owner input', () => {
  const parse = createBncrMessagingExplicitTargetParser();
  const result = parse({ raw: 'Bncr:tgBot:0:10001' });
  assert.ok(result);
  assert.equal(result.displayScope, 'Bncr:tgBot:0:10001');

  const groupResult = parse({ raw: 'Bncr:tgBot:Group:-1001' });
  assert.ok(groupResult);
  assert.equal(groupResult.displayScope, 'Bncr:tgBot:-1001:0');
});

test('plugin messaging resolveSessionTarget falls back to raw id when not parseable', () => {
  const resolve = createBncrMessagingSessionTargetResolver();
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
    target: 'Bncr:tgBot:0:10001',
    threadId: null,
  });

  assert.ok(result);
  assert.equal(result.channel, 'bncr');
  assert.equal(result.accountId, undefined);
  assert.equal(result.thread, undefined);
});

test('plugin messaging resolveOutboundSessionRoute uses persisted owner instead of host agentId', () => {
  const resolve = createBncrMessagingOutboundSessionRouteResolver(() => bridge());
  const result = resolve({
    cfg: {},
    agentId: 'orion',
    accountId: 'Primary',
    target: 'Bncr:tgBot:-5384397128:0',
  });

  assert.ok(result);
  assert.equal(
    result.sessionKey,
    `agent:public:bncr:group:${Buffer.from('tgBot:-5384397128', 'utf8').toString('hex')}`,
  );
});
