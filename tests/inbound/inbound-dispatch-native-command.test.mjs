import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { dispatchBncrInbound } from '../../src/messaging/inbound/dispatch.ts';
import { parseBncrInboundParams } from '../../src/messaging/inbound/parse.ts';
import { withConsoleCapture } from '../helpers/console-capture.mjs';
import { buildParsedInboundText, createInboundApiStub } from '../helpers/inbound-runtime.mjs';

test('slash verbose command is handled natively and preserves bncr session identity', async () => {
  const { api, storePath } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    isAdmin: true,
    type: 'text',
    msg: '/bncr verbose on',
    mimeType: 'text/plain',
    msgId: 'slash-verbose-on',
  });
  const enqueueCalls = [];
  const activityCalls = [];

  const { result, logLines } = await withConsoleCapture('log', async ({ log }) => {
    const result = await dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed,
      canonicalAgentId: 'orion',
      rememberSessionRoute() {},
      enqueueFromReply: async (args) => {
        enqueueCalls.push(args);
      },
      setInboundActivity: (...args) => activityCalls.push(args),
      scheduleSave() {},
    });
    return { result, logLines: log };
  });

  assert.equal(result.accountId, 'Primary');
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'Verbose logging enabled.');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-verbose-on');
  assert.equal(activityCalls.length, 1);
  const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const entry = stored['agent:orion:bncr:group:7467426f743a2d31303031'];
  assert.ok(entry);
  assert.equal(entry.verboseLevel, 'on');
  assert.equal(entry.label, 'Bncr:tgBot:Group:-1001');
  assert.equal(entry.channel, 'bncr');
  assert.equal(entry.chatType, 'group');
  assert.equal(entry.origin.to, 'Bncr:tgBot:-1001:0');
  assert.equal(entry.deliveryContext.channel, 'bncr');
  assert.equal(entry.route.target.to, 'Bncr:tgBot:-1001:0');
  assert.equal(entry.lastTo, 'Bncr:tgBot:-1001:0');
  assert.ok(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes(
          'verbose command=verbose|accountId=Primary|to=Bncr:tgBot:-1001:0|msgId=slash-verbose-on|result=handled',
        ),
    ),
  );
  assert.equal(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes('"event":"handled-verbose"') &&
        line.includes('"fallbackToAgent":false'),
    ),
    false,
  );
});

test('slash verbose command silently rejects non-admin group callers without normal agent fallback', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    isAdmin: false,
    type: 'text',
    msg: '/bncr verbose on',
    mimeType: 'text/plain',
    msgId: 'slash-verbose-no-admin',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 0);
});

test('slash verbose command still replies to non-admin direct callers', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    isAdmin: false,
    type: 'text',
    msg: '/bncr verbose on',
    mimeType: 'text/plain',
    msgId: 'slash-verbose-no-admin-direct',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'Admin permission required.');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-verbose-no-admin-direct');
});

test('slash verbose command emits detailed native-command JSON only in verbose debug mode', async () => {
  const { api } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    isAdmin: true,
    type: 'text',
    msg: '/bncr verbose on',
    mimeType: 'text/plain',
    msgId: 'slash-verbose-debug',
  });

  const { logLines } = await withConsoleCapture('log', async ({ log }) => {
    await dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: { channels: { bncr: { debug: { verbose: true } } } },
      parsed,
      canonicalAgentId: 'orion',
      rememberSessionRoute() {},
      enqueueFromReply: async () => {},
      setInboundActivity() {},
      scheduleSave() {},
    });
    return { logLines: log };
  });

  assert.ok(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes(
          'verbose command=verbose|accountId=Primary|to=Bncr:tgBot:-1001:0|msgId=slash-verbose-debug|result=handled',
        ),
    ),
  );
  assert.ok(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes('"event":"handled-verbose"') &&
        line.includes('"fallbackToAgent":false') &&
        line.includes('"msgId":"slash-verbose-debug"'),
    ),
  );
});

test('slash command with native reply is handled on bncr route without normal agent fallback', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: true });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'text',
    msg: '/bncr help',
    mimeType: 'text/plain',
    msgId: 'slash-native-reply',
  });
  const enqueueCalls = [];

  const result = await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(result.accountId, 'Primary');
  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.match(enqueueCalls[0].payload.text, /🦞 Bncr command usage/);
  assert.match(enqueueCalls[0].payload.text, /\/bncr whoami/);
  assert.doesNotMatch(enqueueCalls[0].payload.text, /\/status/);
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-native-reply');
});

test('slash whoami command is available to non-admin callers without bridge details', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-client-long-id',
    bridgeId: 'bncr-client-long-id',
    platform: 'tgBot',
    groupId: '-1001',
    groupName: 'wind_system',
    userId: '10001',
    userName: 'xmo',
    isGroup: true,
    isAdmin: false,
    type: 'text',
    msg: '/bncr whoami',
    mimeType: 'text/plain',
    msgId: 'slash-whoami-user',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.match(enqueueCalls[0].payload.text, /🧭 Bncr Identity/);
  assert.match(enqueueCalls[0].payload.text, /User: xmo \(10001\)/);
  assert.match(enqueueCalls[0].payload.text, /Group: wind_system \(-1001\)/);
  assert.match(enqueueCalls[0].payload.text, /Scene: tgBot:-1001/);
  assert.match(enqueueCalls[0].payload.text, /Admin: false/);
  assert.doesNotMatch(enqueueCalls[0].payload.text, /bridge/i);
  assert.doesNotMatch(enqueueCalls[0].payload.text, /client/i);
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-whoami-user');
});

test('bare whoami command is intercepted as bncr identity for non-admin callers', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-client-long-id',
    bridgeId: 'bncr-client-long-id',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    isAdmin: false,
    type: 'text',
    msg: '/whoami',
    mimeType: 'text/plain',
    msgId: 'bare-whoami-user',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.match(enqueueCalls[0].payload.text, /🧭 Bncr Identity/);
  assert.match(enqueueCalls[0].payload.text, /User: xmo \(10001\)/);
  assert.match(enqueueCalls[0].payload.text, /Scene: tgBot:10001/);
  assert.doesNotMatch(enqueueCalls[0].payload.text, /Group:/);
  assert.doesNotMatch(enqueueCalls[0].payload.text, /bridge/i);
  assert.doesNotMatch(enqueueCalls[0].payload.text, /client/i);
  assert.equal(enqueueCalls[0].payload.replyToId, 'bare-whoami-user');
});

test('bare status command is intercepted as bncr scoped status for non-admin direct callers', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-client-long-id',
    bridgeId: 'bncr-client-long-id',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    isAdmin: false,
    type: 'text',
    msg: '/status',
    mimeType: 'text/plain',
    msgId: 'bare-status-user',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'public',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.match(enqueueCalls[0].payload.text, /🦞 Bncr Status/);
  assert.match(enqueueCalls[0].payload.text, /Channel: bncr/);
  assert.match(enqueueCalls[0].payload.text, /User: xmo \(10001\)/);
  assert.match(enqueueCalls[0].payload.text, /Scene: tgBot:10001/);
  assert.match(enqueueCalls[0].payload.text, /Agent: orion/);
  assert.match(enqueueCalls[0].payload.text, /SessionKey: agent:orion:bncr:direct:/);
  assert.equal(enqueueCalls[0].payload.replyToId, 'bare-status-user');
});

test('bare status command falls through to OpenClaw native handling for admin callers', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-client-long-id',
    bridgeId: 'bncr-client-long-id',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    isAdmin: true,
    type: 'text',
    msg: '/status',
    mimeType: 'text/plain',
    msgId: 'bare-status-admin',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'reply from agent');
  assert.equal(calls.builtContexts[0]?.CommandTurn?.commandName, 'status');
});

test('slash bncr status is handled locally for admin callers without native fallback', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-client-long-id',
    bridgeId: 'bncr-client-long-id',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    isAdmin: true,
    type: 'text',
    msg: '/bncr status',
    mimeType: 'text/plain',
    msgId: 'slash-status-admin',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.match(enqueueCalls[0].payload.text, /🦞 Bncr Status/);
  assert.match(enqueueCalls[0].payload.text, /Channel: bncr/);
  assert.match(enqueueCalls[0].payload.text, /User: xmo \(10001\)/);
  assert.match(enqueueCalls[0].payload.text, /Scene: tgBot:10001/);
  assert.match(enqueueCalls[0].payload.text, /Agent: orion/);
  assert.match(enqueueCalls[0].payload.text, /SessionKey: agent:orion:bncr:direct:/);
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-status-admin');
});

test('bare new command is intercepted as formal session reset for non-admin direct callers', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-client-long-id',
    bridgeId: 'bncr-client-long-id',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    isAdmin: false,
    type: 'text',
    msg: '/new',
    mimeType: 'text/plain',
    msgId: 'bare-new-user',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'public',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.deepEqual(calls.requests, [
    {
      method: 'sessions.reset',
      params: {
        key: 'agent:orion:bncr:direct:7467426f743a3130303031',
        reason: 'new',
        agentId: 'orion',
      },
    },
  ]);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].sessionKey, 'agent:orion:bncr:direct:7467426f743a3130303031');
  assert.equal(enqueueCalls[0].payload.text, 'Started a new session for this private chat.');
  assert.equal(enqueueCalls[0].payload.replyToId, 'bare-new-user');
});

test('bare reset command is intercepted as formal session reset for non-admin direct callers', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-client-long-id',
    bridgeId: 'bncr-client-long-id',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    isAdmin: false,
    type: 'text',
    msg: '/reset',
    mimeType: 'text/plain',
    msgId: 'bare-reset-user',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'public',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.deepEqual(calls.requests, [
    {
      method: 'sessions.reset',
      params: {
        key: 'agent:orion:bncr:direct:7467426f743a3130303031',
        reason: 'reset',
        agentId: 'orion',
      },
    },
  ]);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].sessionKey, 'agent:orion:bncr:direct:7467426f743a3130303031');
  assert.equal(enqueueCalls[0].payload.text, 'Reset the current session for this private chat.');
  assert.equal(enqueueCalls[0].payload.replyToId, 'bare-reset-user');
});

test('slash bncr new is handled locally for admin callers without native fallback', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-client-long-id',
    bridgeId: 'bncr-client-long-id',
    platform: 'tgBot',
    groupId: '0',
    userId: '10001',
    userName: 'xmo',
    isGroup: false,
    isAdmin: true,
    type: 'text',
    msg: '/bncr new',
    mimeType: 'text/plain',
    msgId: 'slash-new-admin',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.deepEqual(calls.requests, [
    {
      method: 'sessions.reset',
      params: {
        key: 'agent:orion:bncr:direct:7467426f743a3130303031',
        reason: 'new',
        agentId: 'orion',
      },
    },
  ]);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'Started a new session for this private chat.');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-new-admin');
});

test('slash bncr new replies to group admin callers and invokes session reset', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    isGroup: true,
    isAdmin: true,
    type: 'text',
    msg: '/bncr new',
    mimeType: 'text/plain',
    msgId: 'slash-new-group',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.deepEqual(calls.requests, [
    {
      method: 'sessions.reset',
      params: {
        key: 'agent:orion:bncr:group:7467426f743a2d31303031',
        reason: 'new',
        agentId: 'orion',
      },
    },
  ]);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'Started a new session for this group chat.');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-new-group');
});

test('slash bncr reset replies to group admin callers and invokes session reset', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    isGroup: true,
    isAdmin: true,
    type: 'text',
    msg: '/bncr reset',
    mimeType: 'text/plain',
    msgId: 'slash-reset-group',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.deepEqual(calls.requests, [
    {
      method: 'sessions.reset',
      params: {
        key: 'agent:orion:bncr:group:7467426f743a2d31303031',
        reason: 'reset',
        agentId: 'orion',
      },
    },
  ]);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'Reset the current session for this group chat.');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-reset-group');
});

test('slash bncr new silently ignores non-admin group callers without invoking session reset', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    isGroup: true,
    isAdmin: false,
    type: 'text',
    msg: '/bncr new',
    mimeType: 'text/plain',
    msgId: 'slash-new-group-non-admin',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.deepEqual(calls.requests, []);
  assert.equal(enqueueCalls.length, 0);
});

test('slash bncr reset silently ignores non-admin group callers without invoking session reset', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    isGroup: true,
    isAdmin: false,
    type: 'text',
    msg: '/bncr reset',
    mimeType: 'text/plain',
    msgId: 'slash-reset-group-non-admin',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.deepEqual(calls.requests, []);
  assert.equal(enqueueCalls.length, 0);
});

test('bare whoami command falls through to OpenClaw native handling for admin callers', async () => {
  const { api, calls } = createInboundApiStub();
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-client-long-id',
    bridgeId: 'bncr-client-long-id',
    platform: 'qqBot',
    groupId: '0',
    userId: '58C799392B49460B9959504A0723A2FD',
    userName: 'admin-user',
    isGroup: false,
    isAdmin: true,
    type: 'text',
    msg: '/whoami',
    mimeType: 'text/plain',
    msgId: 'bare-whoami-admin',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 1);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'reply from agent');
  assert.equal(calls.builtContexts[0]?.CommandTurn?.kind, 'text-slash');
  assert.equal(calls.builtContexts[0]?.CommandTurn?.commandName, 'whoami');
});

test('scene admin allow command updates pending registry and replies natively', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'pending',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '20002',
    isGroup: true,
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr allow tgBot:10001',
    mimeType: 'text/plain',
    msgId: 'slash-allow-1',
  });
  const enqueueCalls = [];

  const result = await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 2,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(result.accountId, 'Primary');
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'Allowed scene tgBot:10001.');
  assert.equal(sceneRegistry.get('tgBot:10001')?.status, 'allowed');
  assert.equal(sceneRegistry.get('tgBot:10001')?.agentId, 'main');
});

test('scene admin allow without current-group context rejects without falling through to agent', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: false });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    userId: '20002',
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr allow',
    mimeType: 'text/plain',
    msgId: 'slash-allow-invalid',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry: new Map(),
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 2,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(
    enqueueCalls[0].payload.text,
    'Current group shortcut only works inside a group chat.',
  );
});

test('scene admin deny command marks scene denied', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'pending',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    userId: '20002',
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr deny tgBot:10001',
    mimeType: 'text/plain',
    msgId: 'slash-deny-1',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 3,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(enqueueCalls[0].payload.text, 'Denied scene tgBot:10001.');
  assert.equal(sceneRegistry.get('tgBot:10001')?.status, 'denied');
});

test('scene admin bind command only updates agent binding', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        agentId: 'public',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    userId: '20002',
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr bind custom-agent tgBot:-1001',
    mimeType: 'text/plain',
    msgId: 'slash-bind-1',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 4,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(enqueueCalls[0].payload.text, 'Bound tgBot:-1001 to agent custom-agent.');
  assert.equal(sceneRegistry.get('tgBot:-1001')?.status, 'allowed');
  assert.equal(sceneRegistry.get('tgBot:-1001')?.agentId, 'custom-agent');
});

test('scene admin bind command supports current group shorthand', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        agentId: 'public',
        groupReplyMode: 'admin',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '20002',
    isGroup: true,
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr bind custom-agent',
    mimeType: 'text/plain',
    msgId: 'slash-bind-current-1',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(enqueueCalls[0].payload.text, 'Bound tgBot:-1001 to agent custom-agent.');
  assert.equal(sceneRegistry.get('tgBot:-1001')?.agentId, 'custom-agent');
});

test('scene admin mode command updates group reply mode with explicit scene key', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        agentId: 'public',
        groupReplyMode: 'admin',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    userId: '20002',
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr mode hybrid tgBot:-1001',
    mimeType: 'text/plain',
    msgId: 'slash-mode-1',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(enqueueCalls[0].payload.text, 'Set tgBot:-1001 reply mode to hybrid.');
  assert.equal(sceneRegistry.get('tgBot:-1001')?.groupReplyMode, 'hybrid');
});

test('scene admin mode command updates current group reply mode without explicit scene key', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        agentId: 'public',
        groupReplyMode: 'admin',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '20002',
    isGroup: true,
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr mode hybrid',
    mimeType: 'text/plain',
    msgId: 'slash-mode-current-1',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(enqueueCalls[0].payload.text, 'Set tgBot:-1001 reply mode to hybrid.');
  assert.equal(sceneRegistry.get('tgBot:-1001')?.groupReplyMode, 'hybrid');
});

test('scene admin mode command queries current group reply mode in group chat', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        agentId: 'public',
        groupReplyMode: 'mention',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '20002',
    isGroup: true,
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr mode',
    mimeType: 'text/plain',
    msgId: 'slash-mode-get-1',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(enqueueCalls[0].payload.text, 'Current tgBot:-1001 reply mode is mention.');
});

test('scene admin mode query rejects direct chats', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '20002',
    isGroup: false,
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr mode',
    mimeType: 'text/plain',
    msgId: 'slash-mode-get-direct-1',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry: new Map(),
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(
    enqueueCalls[0].payload.text,
    'Current group mode query only works inside a group chat.',
  );
});

test('scene admin mode help returns dedicated mode guidance', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '20002',
    isGroup: true,
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr mode help',
    mimeType: 'text/plain',
    msgId: 'slash-mode-help-1',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry: new Map(),
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.match(enqueueCalls[0].payload.text, /💬 Bncr Group Reply Mode Configuration/);
  assert.match(enqueueCalls[0].payload.text, /admin: 仅管理员\|消息上送并逐条回复/);
  assert.match(
    enqueueCalls[0].payload.text,
    /hybrid: 全员\|消息上送 管理员逐条回复 其他人仅指定消息触发回复/,
  );
  assert.match(enqueueCalls[0].payload.text, /\/bncr mode <admin|mention|hybrid|all>/);
});

test('scene admin revoke command deletes record for later re-apply', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        agentId: 'main',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    userId: '20002',
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr revoke tgBot:10001',
    mimeType: 'text/plain',
    msgId: 'slash-revoke-1',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(enqueueCalls[0].payload.text, 'Revoked scene tgBot:10001.');
  assert.equal(sceneRegistry.has('tgBot:10001'), false);
});

test('scene admin allow/deny/revoke commands support current group shorthand', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'denied',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        agentId: 'public',
        groupReplyMode: 'admin',
        lastSeenAt: 1,
      },
    ],
  ]);

  const enqueueCalls = [];
  const run = async (msg, msgId) =>
    dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed: parseBncrInboundParams({
        accountId: 'Primary',
        clientId: 'client-1',
        platform: 'tgBot',
        groupId: '-1001',
        userId: '20002',
        isGroup: true,
        isAdmin: true,
        shouldRespond: true,
        type: 'text',
        msg,
        mimeType: 'text/plain',
        msgId,
      }),
      canonicalAgentId: 'main',
      sceneRegistry,
      defaultAdminAgentId: 'main',
      defaultPublicAgentId: 'public',
      now: () => 5,
      rememberSessionRoute() {},
      enqueueFromReply: async (args) => {
        enqueueCalls.push(args);
      },
      setInboundActivity() {},
      scheduleSave() {},
    });

  await run('/bncr allow', 'slash-allow-current-1');
  assert.equal(enqueueCalls.at(-1).payload.text, 'Allowed scene tgBot:-1001.');
  assert.equal(sceneRegistry.get('tgBot:-1001')?.status, 'allowed');

  await run('/bncr deny', 'slash-deny-current-1');
  assert.equal(enqueueCalls.at(-1).payload.text, 'Denied scene tgBot:-1001.');
  assert.equal(sceneRegistry.get('tgBot:-1001')?.status, 'denied');

  await run('/bncr revoke', 'slash-revoke-current-1');
  assert.equal(enqueueCalls.at(-1).payload.text, 'Revoked scene tgBot:-1001.');
  assert.equal(sceneRegistry.has('tgBot:-1001'), false);
});

test('scene admin list pending only includes pending records', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'pending',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        lastSeenAt: 2,
      },
    ],
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        agentId: 'public',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    userId: '20002',
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr list pending',
    mimeType: 'text/plain',
    msgId: 'slash-list-pending',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.match(
    enqueueCalls[0].payload.text,
    /^📱 Private Chat public\n\n {2}SceneId: tgBot:10001\n {2}Details: status=pending id=10001 name=xmo$/,
  );
});

test('scene admin list pending filters pending scenes by search terms', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'pending',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        lastSeenAt: 2,
      },
    ],
    [
      'tgBot:-1002',
      {
        sceneKey: 'tgBot:-1002',
        kind: 'group',
        status: 'pending',
        platform: 'tgBot',
        groupId: '-1002',
        groupName: 'beta_group',
        agentId: 'zeta',
        groupReplyMode: 'mention',
        lastSeenAt: 3,
      },
    ],
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        agentId: 'public',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    userId: '20002',
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr list pending zeta mention',
    mimeType: 'text/plain',
    msgId: 'slash-list-pending-filtered',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.match(
    enqueueCalls[0].payload.text,
    /^👥 Group Chat zeta mention\n\n {2}SceneId: tgBot:-1002\n {2}Details: status=pending id=-1002 name=beta_group$/,
  );
});

test('scene admin list pending reports when filters match no pending scenes', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'pending',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    userId: '20002',
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr list pending zeta',
    mimeType: 'text/plain',
    msgId: 'slash-list-pending-no-match',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(enqueueCalls[0].payload.text, 'No pending scenes matched: zeta');
});

test('scene admin list scenes returns private groups first and group groups sorted by title', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'pending',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        lastSeenAt: 2,
      },
    ],
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        agentId: 'public',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    userId: '20002',
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr list scenes',
    mimeType: 'text/plain',
    msgId: 'slash-list-scenes',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.match(
    enqueueCalls[0].payload.text,
    /^📱 Private Chat public\n\n {2}SceneId: tgBot:10001\n {2}Details: status=pending id=10001 name=xmo\n\n👥 Group Chat public admin\n\n {2}SceneId: tgBot:-1001\n {2}Details: status=allowed id=-1001 name=wind_system$/,
  );
});

test('scene admin list scenes sorts multiple group chat sections by title after private chat sections', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:-1002',
      {
        sceneKey: 'tgBot:-1002',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1002',
        groupName: 'beta_group',
        agentId: 'zeta',
        groupReplyMode: 'mention',
        lastSeenAt: 1,
      },
    ],
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        lastSeenAt: 3,
      },
    ],
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'pending',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'alpha_group',
        agentId: 'alpha',
        groupReplyMode: 'admin',
        lastSeenAt: 2,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    userId: '20002',
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr list scenes',
    mimeType: 'text/plain',
    msgId: 'slash-list-scenes-sorted-groups',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.match(
    enqueueCalls[0].payload.text,
    /^📱 Private Chat public\n\n {2}SceneId: tgBot:10001\n {2}Details: status=allowed id=10001 name=xmo\n\n👥 Group Chat alpha admin\n\n {2}SceneId: tgBot:-1001\n {2}Details: status=pending id=-1001 name=alpha_group\n\n👥 Group Chat zeta mention\n\n {2}SceneId: tgBot:-1002\n {2}Details: status=allowed id=-1002 name=beta_group$/,
  );
});

test('scene admin list scenes filters by agent mode and platform terms', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:-1002',
      {
        sceneKey: 'tgBot:-1002',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1002',
        groupName: 'beta_group',
        agentId: 'zeta',
        groupReplyMode: 'mention',
        lastSeenAt: 1,
      },
    ],
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        lastSeenAt: 3,
      },
    ],
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'pending',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'alpha_group',
        agentId: 'alpha',
        groupReplyMode: 'admin',
        lastSeenAt: 2,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    userId: '20002',
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr list scenes zeta mention',
    mimeType: 'text/plain',
    msgId: 'slash-list-scenes-filtered',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.match(
    enqueueCalls[0].payload.text,
    /^👥 Group Chat zeta mention\n\n {2}SceneId: tgBot:-1002\n {2}Details: status=allowed id=-1002 name=beta_group$/,
  );
});

test('scene admin list scenes reports when filters match nothing', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'allowed',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    userId: '20002',
    isAdmin: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr list scenes nope',
    mimeType: 'text/plain',
    msgId: 'slash-list-scenes-no-match',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 5,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(enqueueCalls[0].payload.text, 'No scenes matched: nope');
});

test('scene admin commands reject non-admin callers without falling through to agent', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'pending',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    userId: '20002',
    isAdmin: false,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr deny tgBot:10001',
    mimeType: 'text/plain',
    msgId: 'slash-deny-no-admin',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 2,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls[0].payload.text, 'Admin permission required.');
  assert.equal(sceneRegistry.get('tgBot:10001')?.status, 'pending');
});

test('scene admin commands reject non-admin group callers with admin permission required without falling through to agent', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:10001',
      {
        sceneKey: 'tgBot:10001',
        kind: 'direct',
        status: 'pending',
        platform: 'tgBot',
        userId: '10001',
        userName: 'xmo',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '20002',
    isAdmin: false,
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr deny tgBot:10001',
    mimeType: 'text/plain',
    msgId: 'slash-deny-no-admin-group',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 2,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'Admin permission required.');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-deny-no-admin-group');
});

test('scene admin commands reply with admin permission required for all-mode non-admin group callers', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        groupReplyMode: 'all',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '20002',
    isAdmin: false,
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr deny tgBot:10001',
    mimeType: 'text/plain',
    msgId: 'slash-deny-all-mode-non-admin',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 2,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'Admin permission required.');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-deny-all-mode-non-admin');
});

test('scene admin commands reject non-admin group callers outside all mode with admin permission required', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: false });
  const sceneRegistry = new Map([
    [
      'tgBot:-1001',
      {
        sceneKey: 'tgBot:-1001',
        kind: 'group',
        status: 'allowed',
        platform: 'tgBot',
        groupId: '-1001',
        groupName: 'wind_system',
        groupReplyMode: 'admin',
        lastSeenAt: 1,
      },
    ],
  ]);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '20002',
    isAdmin: false,
    isGroup: true,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr mode',
    mimeType: 'text/plain',
    msgId: 'slash-mode-invalid-non-admin-group',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'main',
    sceneRegistry,
    defaultAdminAgentId: 'main',
    defaultPublicAgentId: 'public',
    now: () => 2,
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'Admin permission required.');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-mode-invalid-non-admin-group');
});

test('unsupported direct slash command is rejected by bncr without falling through to agent', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: false });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '20002',
    isAdmin: false,
    isGroup: false,
    shouldRespond: true,
    type: 'text',
    msg: '/model gpt-5',
    mimeType: 'text/plain',
    msgId: 'slash-model-no-admin-direct',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'public',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'Unsupported private-chat command: /model');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-model-no-admin-direct');
});

test('supported but unauthorized direct bncr subcommand still returns local permission denial without falling through to agent', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: false });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '0',
    userId: '20002',
    isAdmin: false,
    isGroup: false,
    shouldRespond: true,
    type: 'text',
    msg: '/bncr verbose on',
    mimeType: 'text/plain',
    msgId: 'slash-bncr-verbose-no-admin-direct',
  });
  const enqueueCalls = [];

  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'public',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].payload.text, 'Admin permission required.');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-bncr-verbose-no-admin-direct');
});

test('slash command with no native reply falls back to normal bncr agent inbound instead of webchat', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: false });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'text',
    msg: '/unknown-native-command',
    mimeType: 'text/plain',
    msgId: 'slash-fallback-1',
  });
  const enqueueCalls = [];

  const { result, logLines } = await withConsoleCapture('log', async ({ log }) => {
    const result = await dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: {},
      parsed,
      canonicalAgentId: 'orion',
      rememberSessionRoute() {},
      enqueueFromReply: async (args) => {
        enqueueCalls.push(args);
      },
      setInboundActivity() {},
      scheduleSave() {},
    });
    return { result, logLines: log };
  });

  assert.equal(result.accountId, 'Primary');
  assert.equal(calls.turnRuns.length, 1);
  assert.equal(calls.turnRuns[0].ctxPayload.CommandTurn?.kind, undefined);
  assert.equal(calls.turnRuns[0].ctxPayload.Body, 'ENV:/unknown-native-command');
  assert.equal(calls.turnRuns[0].ctxPayload.BodyForAgent, 'ENV:/unknown-native-command');
  assert.equal(calls.turnRuns[0].ctxPayload.RawBody, '/unknown-native-command');
  assert.equal(calls.turnRuns[0].ctxPayload.CommandBody, '/unknown-native-command');
  assert.equal(calls.turnRuns[0].ctxPayload.BodyForCommands, '/unknown-native-command');
  assert.deepEqual(
    calls.turnRuns[0].ctxPayload.BncrStructuredContextFacts,
    calls.turnRuns[0].ctxPayload.StructuredContextFacts,
  );
  assert.equal(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.message.envelopeBody,
    'ENV:/unknown-native-command',
  );
  assert.equal(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.message.bodyForAgent,
    '/unknown-native-command',
  );
  assert.equal(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.message.commandBody,
    '/unknown-native-command',
  );
  assert.equal(calls.turnRuns[0].ctxPayload.StructuredContextFacts.reply.to, 'Bncr:tgBot:-1001:0');
  assert.deepEqual(calls.turnRuns[0].ctxPayload.UntrustedStructuredContext, [
    {
      label: 'Bncr inbound context',
      source: 'bncr',
      type: 'bncr.inbound_context',
      payload: {
        platform: 'bncr/tgBot',
        conversation_context: [
          {
            messageId: 'slash-fallback-1',
            timestamp:
              calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext[0].timestamp,
            role: 'user',
            sender: 'Bncr:tgBot:-1001:0',
            senderId: '10001',
            content: '/unknown-native-command',
          },
        ],
        participants: {
          10001: {
            name: 'Bncr:tgBot:-1001:0',
            isBot: false,
            role: 'user',
            displayName: 'Bncr:tgBot:-1001:0',
          },
        },
        is_group_chat: true,
        account_id: 'Primary',
        reply: {
          to: 'Bncr:tgBot:-1001:0',
          originatingTo: 'Bncr:tgBot:-1001:0',
          rawTo: 'Bncr:tgBot:-1001:10001',
        },
      },
    },
  ]);
  assert.equal(calls.turnRuns[0].ctxPayload.To, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.turnRuns[0].ctxPayload.OriginatingTo, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.turnRuns[0].ctxPayload.ConversationLabel, 'Bncr:tgBot:-1001:0');
  assert.equal(
    calls.turnRuns[0].ctxPayload.SessionKey,
    'agent:orion:bncr:group:7467426f743a2d31303031',
  );
  assert.equal(calls.recorded.length, 1);
  assert.equal(calls.recorded[0].ctx.To, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.recorded[0].ctx.OriginatingTo, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.recorded[0].ctx.ConversationLabel, 'Bncr:tgBot:-1001:0');
  assert.equal(calls.recorded[0].ctx.SessionKey, 'agent:orion:bncr:group:7467426f743a2d31303031');
  assert.equal(
    logLines.some(
      (line) => line.includes('[bncr] native-command') && line.includes('"event":"detected"'),
    ),
    false,
  );
  assert.equal(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes(
          'fallback command=unknown-native-command|accountId=Primary|to=Bncr:tgBot:-1001:0|msgId=slash-fallback-1|reason=no-payload',
        ),
    ),
    false,
  );
  assert.equal(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes('"event":"no-payload-fallback-to-agent"') &&
        line.includes('"fallbackToAgent":true'),
    ),
    false,
  );
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].sessionKey, 'agent:orion:bncr:group:7467426f743a2d31303031');
  assert.deepEqual(enqueueCalls[0].route, {
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
  });
  assert.equal(enqueueCalls[0].payload.text, 'reply from agent');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-fallback-1');
});

test('slash command fallback emits detailed native-command JSON only in verbose debug mode', async () => {
  const { api } = createInboundApiStub({ nativeCommandProducesReply: false });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'text',
    msg: '/unknown-native-command',
    mimeType: 'text/plain',
    msgId: 'slash-fallback-debug',
  });

  const { logLines } = await withConsoleCapture('log', async ({ log }) => {
    await dispatchBncrInbound({
      api,
      channelId: 'bncr',
      cfg: { channels: { bncr: { debug: { verbose: true } } } },
      parsed,
      canonicalAgentId: 'orion',
      rememberSessionRoute() {},
      enqueueFromReply: async () => {},
      setInboundActivity() {},
      scheduleSave() {},
    });
    return { logLines: log };
  });

  assert.equal(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes(
          'fallback command=unknown-native-command|accountId=Primary|to=Bncr:tgBot:-1001:0|msgId=slash-fallback-debug|reason=no-payload',
        ),
    ),
    false,
  );
  assert.equal(
    logLines.some(
      (line) =>
        line.includes('[bncr] native-command') &&
        line.includes('"event":"no-payload-fallback-to-agent"') &&
        line.includes('"fallbackToAgent":true') &&
        line.includes('"msgId":"slash-fallback-debug"'),
    ),
    false,
  );
});

test('slash command without clientId still falls back to normal bncr agent inbound', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: false });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'text',
    msg: '/unknown-native-command',
    mimeType: 'text/plain',
    msgId: 'slash-fallback-no-client',
  });
  const enqueueCalls = [];

  const result = await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(result.accountId, 'Primary');
  assert.equal(calls.turnRuns.length, 1);
  assert.equal(calls.turnRuns[0].ctxPayload.CommandTurn?.kind, undefined);
  assert.equal(calls.turnRuns[0].ctxPayload.SenderId, '10001');
  assert.equal(calls.turnRuns[0].ctxPayload.Body, 'ENV:/unknown-native-command');
  assert.equal(calls.turnRuns[0].ctxPayload.BodyForAgent, 'ENV:/unknown-native-command');
  assert.equal(calls.turnRuns[0].ctxPayload.RawBody, '/unknown-native-command');
  assert.equal(calls.turnRuns[0].ctxPayload.CommandBody, '/unknown-native-command');
  assert.equal(calls.turnRuns[0].ctxPayload.BodyForCommands, '/unknown-native-command');
  assert.deepEqual(
    calls.turnRuns[0].ctxPayload.BncrStructuredContextFacts,
    calls.turnRuns[0].ctxPayload.StructuredContextFacts,
  );
  assert.equal(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.message.envelopeBody,
    'ENV:/unknown-native-command',
  );
  assert.equal(calls.turnRuns[0].ctxPayload.StructuredContextFacts.sender.id, '10001');
  assert.equal(
    calls.turnRuns[0].ctxPayload.StructuredContextFacts.sender.displayName,
    'Bncr:tgBot:-1001:0',
  );
  assert.equal(calls.turnRuns[0].ctxPayload.SenderId, '10001');
  assert.deepEqual(calls.turnRuns[0].ctxPayload.UntrustedStructuredContext, [
    {
      label: 'Bncr inbound context',
      source: 'bncr',
      type: 'bncr.inbound_context',
      payload: {
        platform: 'bncr/tgBot',
        conversation_context: [
          {
            messageId: 'slash-fallback-no-client',
            timestamp:
              calls.turnRuns[0].ctxPayload.StructuredContextFacts.conversationContext[0].timestamp,
            role: 'user',
            sender: 'Bncr:tgBot:-1001:0',
            senderId: '10001',
            content: '/unknown-native-command',
          },
        ],
        participants: {
          10001: {
            name: 'Bncr:tgBot:-1001:0',
            isBot: false,
            role: 'user',
            displayName: 'Bncr:tgBot:-1001:0',
          },
        },
        is_group_chat: true,
        account_id: 'Primary',
        reply: {
          to: 'Bncr:tgBot:-1001:0',
          originatingTo: 'Bncr:tgBot:-1001:0',
          rawTo: 'Bncr:tgBot:-1001:10001',
        },
      },
    },
  ]);
  assert.equal(calls.turnRuns[0].ctxPayload.To, 'Bncr:tgBot:-1001:0');
  assert.equal(
    calls.turnRuns[0].ctxPayload.SessionKey,
    'agent:orion:bncr:group:7467426f743a2d31303031',
  );
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].sessionKey, 'agent:orion:bncr:group:7467426f743a2d31303031');
  assert.deepEqual(enqueueCalls[0].route, {
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
  });
  assert.equal(enqueueCalls[0].payload.text, 'reply from agent');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-fallback-no-client');
});

test('native command help reply and fallback reply keep the same canonical session route', async () => {
  const nativeReplyStub = createInboundApiStub({ nativeCommandProducesReply: true });
  const fallbackStub = createInboundApiStub({ nativeCommandProducesReply: false });
  const nativeParsed = parseBncrInboundParams(
    buildParsedInboundText({ msg: '/bncr help', msgId: 'slash-help-route' }),
  );
  const fallbackParsed = parseBncrInboundParams(
    buildParsedInboundText({ msg: '/unknown-native-command', msgId: 'slash-fallback-route' }),
  );
  const nativeEnqueueCalls = [];
  const fallbackEnqueueCalls = [];

  await dispatchBncrInbound({
    api: nativeReplyStub.api,
    channelId: 'bncr',
    cfg: {},
    parsed: nativeParsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      nativeEnqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });
  await dispatchBncrInbound({
    api: fallbackStub.api,
    channelId: 'bncr',
    cfg: {},
    parsed: fallbackParsed,
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      fallbackEnqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(nativeEnqueueCalls[0].sessionKey, fallbackEnqueueCalls[0].sessionKey);
  assert.deepEqual(nativeEnqueueCalls[0].route, fallbackEnqueueCalls[0].route);
  assert.equal(nativeEnqueueCalls[0].payload.replyToId, 'slash-help-route');
  assert.equal(fallbackEnqueueCalls[0].payload.replyToId, 'slash-fallback-route');
});

test('native command honors admitted resolvedAgentId for group session routing', async () => {
  const { api, calls } = createInboundApiStub({ nativeCommandProducesReply: true });
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'client-1',
    platform: 'tgBot',
    groupId: '-1001',
    userId: '10001',
    type: 'text',
    msg: '/bncr help',
    mimeType: 'text/plain',
    msgId: 'slash-help-public',
  });
  const enqueueCalls = [];

  const result = await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    resolvedAgentId: 'public',
    sceneRegistry: new Map(),
    defaultAdminAgentId: 'orion',
    defaultPublicAgentId: 'public',
    now: () => Date.now(),
    rememberSessionRoute() {},
    enqueueFromReply: async (args) => {
      enqueueCalls.push(args);
    },
    setInboundActivity() {},
    scheduleSave() {},
  });

  assert.equal(result.sessionKey, 'agent:public:bncr:group:7467426f743a2d31303031');
  assert.equal(calls.turnRuns.length, 0);
  assert.equal(enqueueCalls.length, 1);
  assert.equal(enqueueCalls[0].sessionKey, 'agent:public:bncr:group:7467426f743a2d31303031');
  assert.equal(enqueueCalls[0].payload.replyToId, 'slash-help-public');
});
