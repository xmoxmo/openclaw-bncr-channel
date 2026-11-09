import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCommandAuthorizationAsync } from 'openclaw/plugin-sdk/command-auth-native';
import {
  mergeBncrOwnerAllowFromIntoConfig,
  resolveBncrHostOwnerConfigOverride,
} from '../../src/messaging/inbound/command-owner.ts';
import { dispatchBncrInbound } from '../../src/messaging/inbound/dispatch.ts';
import { parseBncrInboundParams } from '../../src/messaging/inbound/parse.ts';
import { dispatchOpenClawReplyWithBufferedBlockDispatcher } from '../../src/openclaw/reply-runtime.ts';
import { createInboundApiStub } from '../helpers/inbound-runtime.mjs';

function parseText({
  isAdmin,
  msg = 'hello',
  shouldRespond = true,
  isGroup = false,
  groupId = '0',
  triggerKind = 'none',
}) {
  return parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-client-1',
    bridgeId: 'bncr-client-1',
    platform: 'tgBot',
    groupId,
    userId: 'kvictor',
    userName: 'kvictor',
    isGroup,
    isAdmin,
    shouldRespond,
    triggerKind,
    type: 'text',
    msg,
    msgId: `owner-${isAdmin ? 'admin' : 'user'}-${isGroup ? 'group' : 'direct'}-${msg}`,
  });
}

function installHostReplyDispatchSpy(api, calls) {
  const reply = api.runtime.channel.reply;
  const originalBufferedDispatch = reply.dispatchReplyWithBufferedBlockDispatcher;
  reply.dispatchReplyFromConfig = async (request) => {
    calls.hostConfigOverrides.push(request?.configOverride);
    return [];
  };
  reply.dispatchReplyWithBufferedBlockDispatcher = async (params) => {
    calls.replyDispatches.push(params);
    if (typeof params.dispatchReplyFromConfig === 'function') {
      await params.dispatchReplyFromConfig({
        ctx: params.ctx,
        cfg: params.cfg,
        dispatcher: {},
        replyOptions: params.replyOptions,
      });
    }
    return originalBufferedDispatch({
      ctx: params.ctx,
      dispatcherOptions: params.dispatcherOptions,
    });
  };
}

async function dispatchText({
  isAdmin,
  msg = 'hello',
  cfg = {},
  isGroup = false,
  groupId = '0',
  triggerKind = 'none',
}) {
  const { api, calls } = createInboundApiStub();
  calls.hostConfigOverrides = [];
  calls.replyDispatches = [];
  installHostReplyDispatchSpy(api, calls);
  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg,
    parsed: parseText({ isAdmin, msg, isGroup, groupId, triggerKind }),
    canonicalAgentId: 'orion',
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });
  return calls;
}

test('dynamic owner injection remains a cloned config that keeps existing owners', () => {
  const cfg = { commands: { ownerAllowFrom: ['existing-owner'] } };
  const merged = mergeBncrOwnerAllowFromIntoConfig({
    cfg,
    senderIdForContext: 'kvictor',
  });
  assert.notEqual(merged, cfg);
  assert.deepEqual(merged.commands.ownerAllowFrom, ['existing-owner', 'kvictor']);
  assert.deepEqual(cfg.commands.ownerAllowFrom, ['existing-owner']);
});

test('ordinary sender identity is unchanged by temporary command authorization', async () => {
  const calls = await dispatchText({ isAdmin: false, msg: 'plain message' });
  assert.equal(calls.replyDispatches.length, 1);
  assert.equal(calls.replyDispatches[0].ctx.SenderId, 'kvictor');
  assert.deepEqual(calls.hostConfigOverrides, []);
  assert.equal(calls.replyDispatches[0].cfg.commands?.ownerAllowFrom, undefined);
});

test('non-admin group turns never derive owner identity from their reply mode', async () => {
  for (const triggerKind of ['mention', 'all', 'hybrid', 'admin']) {
    const calls = await dispatchText({
      isAdmin: false,
      msg: 'group message',
      isGroup: true,
      groupId: '-1001',
      triggerKind,
    });
    assert.equal(calls.replyDispatches.length, 1);
    assert.deepEqual(calls.hostConfigOverrides, []);
    assert.equal(calls.replyDispatches[0].cfg.commands?.ownerAllowFrom, undefined);
  }
});

test('admin ordinary turn exposes a one-turn owner override to the host dispatch', async () => {
  const cfg = { commands: { ownerAllowFrom: ['existing-owner'] } };
  const calls = await dispatchText({ isAdmin: true, msg: 'plain message', cfg });
  assert.equal(calls.replyDispatches.length, 1);
  assert.deepEqual(calls.replyDispatches[0].cfg.commands.ownerAllowFrom, [
    'existing-owner',
    'kvictor',
  ]);
  assert.deepEqual(calls.hostConfigOverrides, [
    { commands: { ownerAllowFrom: ['existing-owner', 'kvictor'] } },
  ]);
  assert.deepEqual(cfg.commands.ownerAllowFrom, ['existing-owner']);
});

test('admin native command exposes a one-turn owner override to the host dispatch', async () => {
  const calls = await dispatchText({ isAdmin: true, msg: '/status' });
  assert.equal(calls.replyDispatches.length, 1);
  assert.deepEqual(calls.replyDispatches[0].cfg.commands.ownerAllowFrom, ['kvictor']);
  assert.deepEqual(calls.hostConfigOverrides, [{ commands: { ownerAllowFrom: ['kvictor'] } }]);
});

test('admin /stop fast path exposes the same one-turn owner override', async () => {
  const calls = await dispatchText({ isAdmin: true, msg: '/stop' });
  assert.equal(calls.replyDispatches.length, 1);
  assert.deepEqual(calls.hostConfigOverrides, [{ commands: { ownerAllowFrom: ['kvictor'] } }]);
});

test('a synthesized history flush never inherits the carrier sender admin identity', async () => {
  const { api, calls } = createInboundApiStub();
  calls.hostConfigOverrides = [];
  calls.replyDispatches = [];
  installHostReplyDispatchSpy(api, calls);
  const parsed = parseBncrInboundParams({
    accountId: 'Primary',
    clientId: 'bncr-history-system',
    bridgeId: 'bncr-history-system',
    platform: 'tgBot',
    groupId: '-1001',
    userId: 'kvictor',
    userName: 'kvictor',
    isGroup: true,
    isAdmin: true,
    type: 'text',
    msg: 'carrier message',
    msgId: 'admin-history-flush-carrier',
  });
  await dispatchBncrInbound({
    api,
    channelId: 'bncr',
    cfg: {},
    parsed,
    canonicalAgentId: 'orion',
    shouldDispatch: false,
    shouldAccumulate: false,
    forceSilentHistoryFlush: true,
    conversationHistories: new Map([
      [
        'Primary:tgBot:-1001',
        [
          {
            sender: 'alice',
            senderId: '10002',
            role: 'user',
            body: 'history text',
            timestamp: 1,
            messageId: 'admin-history-flush-entry',
          },
        ],
      ],
    ]),
    rememberSessionRoute() {},
    enqueueFromReply: async () => {},
    setInboundActivity() {},
    scheduleSave() {},
  });
  assert.equal(calls.replyDispatches.length, 1);
  assert.equal(calls.replyDispatches[0].ctx.SenderId, 'bncr-history-system');
  assert.deepEqual(calls.hostConfigOverrides, []);
});

test('non-admin /stop fast path never exposes a one-turn owner override', async () => {
  const calls = await dispatchText({ isAdmin: false, msg: '/stop' });
  assert.equal(calls.replyDispatches.length, 1);
  assert.deepEqual(calls.hostConfigOverrides, []);
});

test('non-admin temporary native command never exposes a host owner override', async () => {
  const calls = await dispatchText({ isAdmin: false, msg: '/whoami' });
  assert.equal(calls.replyDispatches.length, 1);
  assert.deepEqual(calls.hostConfigOverrides, []);
  assert.deepEqual(calls.replyDispatches[0].ctx.OwnerAllowFrom, ['kvictor']);
  assert.equal(calls.replyDispatches[0].ctx.CommandTurn?.kind, 'native');
});

test('host standard authorization accepts the merged per-turn owner list', async () => {
  const cfg = { commands: { ownerAllowFrom: ['existing-owner'] } };
  const patch = resolveBncrHostOwnerConfigOverride({
    cfg,
    isAdmin: true,
    senderId: 'kvictor',
  });
  assert.deepEqual(patch, { commands: { ownerAllowFrom: ['existing-owner', 'kvictor'] } });
  const auth = await resolveCommandAuthorizationAsync({
    ctx: { SenderId: 'kvictor', Provider: 'bncr', Surface: 'bncr' },
    cfg: { ...cfg, ...patch },
    commandAuthorized: true,
  });
  assert.equal(auth.senderIsOwner, true);
  assert.equal(auth.senderId, 'kvictor');
});

test('admin identity is not inferred from untrusted prompt owner facts', () => {
  assert.equal(
    resolveBncrHostOwnerConfigOverride({
      cfg: { commands: { ownerAllowFrom: [] } },
      isAdmin: false,
      senderId: 'kvictor',
    }),
    undefined,
  );
});

test('an empty sender never creates a per-turn owner patch', () => {
  assert.equal(
    resolveBncrHostOwnerConfigOverride({
      cfg: { commands: { ownerAllowFrom: [] } },
      isAdmin: true,
      senderId: '   ',
    }),
    undefined,
  );
});

test('host standard authorization rejects a non-admin sender', async () => {
  const auth = await resolveCommandAuthorizationAsync({
    ctx: { SenderId: 'kvictor', Provider: 'bncr', Surface: 'bncr' },
    cfg: { commands: { ownerAllowFrom: ['existing-owner'] } },
    commandAuthorized: true,
  });
  assert.equal(auth.senderIsOwner, false);
});

test('reply runtime forwards the per-turn owner merge patch unchanged', async () => {
  const calls = [];
  const api = {
    runtime: {
      channel: {
        reply: {
          async dispatchReplyFromConfig(request) {
            calls.push(['dispatchReplyFromConfig', request.configOverride]);
            return [];
          },
          async dispatchReplyWithBufferedBlockDispatcher(params) {
            calls.push(['dispatchReplyWithBufferedBlockDispatcher', params]);
            await params.dispatchReplyFromConfig?.({ ctx: params.ctx, cfg: params.cfg });
            return 'ok';
          },
        },
      },
    },
  };

  assert.equal(
    await dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
      ctx: { SenderId: 'kvictor' },
      cfg: { commands: { ownerAllowFrom: [] } },
      hostDispatchConfig: { commands: { ownerAllowFrom: ['kvictor'] } },
      dispatcherOptions: { async deliver() {} },
    }),
    'ok',
  );
  assert.equal(calls[0][0], 'dispatchReplyWithBufferedBlockDispatcher');
  assert.equal(typeof calls[0][1].dispatchReplyFromConfig, 'function');
  assert.deepEqual(calls[1], [
    'dispatchReplyFromConfig',
    { commands: { ownerAllowFrom: ['kvictor'] } },
  ]);
});

test('reply runtime preserves an existing host config override and other dispatch fields', async () => {
  const calls = [];
  const ctx = { SenderId: 'kvictor' };
  const cfg = { commands: { ownerAllowFrom: [] } };
  const dispatcherOptions = { async deliver() {} };
  const replyOptions = { disableBlockStreaming: true };
  const existingShared = { marker: 'shared' };
  const api = {
    runtime: {
      channel: {
        reply: {
          async dispatchReplyFromConfig(request) {
            calls.push(request);
            return [];
          },
          async dispatchReplyWithBufferedBlockDispatcher(params) {
            await params.dispatchReplyFromConfig({
              ctx,
              cfg,
              dispatcher: existingShared,
              configOverride: { agents: { defaults: { timeoutSeconds: 30 } } },
            });
            return 'ok';
          },
        },
      },
    },
  };
  assert.equal(
    await dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
      ctx,
      cfg,
      dispatcherOptions,
      replyOptions,
      hostDispatchConfig: { commands: { ownerAllowFrom: ['kvictor'] } },
      extraField: 'preserved',
    }),
    'ok',
  );
  assert.equal(calls[0].dispatcher, existingShared);
  assert.equal('hostDispatchConfig' in calls[0], false);
  assert.deepEqual(calls[0].configOverride, {
    agents: { defaults: { timeoutSeconds: 30 } },
    commands: { ownerAllowFrom: ['kvictor'] },
  });
});

test('reply runtime keeps sibling command overrides when the host already has commands', async () => {
  const calls = [];
  const cfg = { commands: { ownerAllowFrom: [] } };
  const existingOverride = {
    commands: {
      nativeSkills: 'auto',
      ownerAllowFrom: ['host-live-owner'],
    },
    agents: { defaults: { timeoutSeconds: 30 } },
  };
  const api = {
    runtime: {
      channel: {
        reply: {
          async dispatchReplyFromConfig(request) {
            calls.push(request);
            return [];
          },
          async dispatchReplyWithBufferedBlockDispatcher(params) {
            await params.dispatchReplyFromConfig({
              ctx: params.ctx,
              cfg: params.cfg,
              configOverride: existingOverride,
            });
            return 'ok';
          },
        },
      },
    },
  };
  assert.equal(
    await dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
      ctx: { SenderId: 'kvictor' },
      cfg,
      dispatcherOptions: { async deliver() {} },
      hostDispatchConfig: { commands: { ownerAllowFrom: ['kvictor'] } },
    }),
    'ok',
  );
  assert.deepEqual(calls[0].configOverride, {
    agents: { defaults: { timeoutSeconds: 30 } },
    commands: {
      nativeSkills: 'auto',
      ownerAllowFrom: ['host-live-owner', 'kvictor'],
    },
  });
  assert.deepEqual(existingOverride.commands.ownerAllowFrom, ['host-live-owner']);
});

test('reply runtime rejects a host configOverride shape that conflicts with the owner patch', async () => {
  const cases = [
    { configOverride: [], reason: /not a merge patch object/ },
    { configOverride: { commands: null }, reason: /commands conflict/ },
    {
      configOverride: { commands: { ownerAllowFrom: 'host-live-owner' } },
      reason: /ownerAllowFrom conflicts/,
    },
  ];
  for (const item of cases) {
    const api = {
      runtime: {
        channel: {
          reply: {
            async dispatchReplyFromConfig() {
              return [];
            },
            async dispatchReplyWithBufferedBlockDispatcher(params) {
              await params.dispatchReplyFromConfig({ configOverride: item.configOverride });
              return 'ok';
            },
          },
        },
      },
    };
    await assert.rejects(
      dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
        ctx: { SenderId: 'kvictor' },
        cfg: {},
        dispatcherOptions: { async deliver() {} },
        hostDispatchConfig: { commands: { ownerAllowFrom: ['kvictor'] } },
      }),
      item.reason,
    );
  }
});

test('ordinary turns keep the host reply dispatch unchanged', async () => {
  const calls = [];
  const api = {
    runtime: {
      channel: {
        reply: {
          async dispatchReplyWithBufferedBlockDispatcher(params) {
            calls.push(params);
            return 'ok';
          },
        },
      },
    },
  };

  assert.equal(
    await dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
      ctx: { SenderId: 'kvictor' },
      cfg: { commands: { ownerAllowFrom: [] } },
      dispatcherOptions: { async deliver() {} },
    }),
    'ok',
  );
  assert.equal(calls.length, 1);
  assert.equal('dispatchReplyFromConfig' in calls[0], false);
  assert.equal('replyOptions' in calls[0], false);
});

test('an owner turn fails clearly when the host config patch API is unavailable', async () => {
  const api = {
    runtime: {
      channel: {
        reply: {
          async dispatchReplyWithBufferedBlockDispatcher() {
            return 'unexpected';
          },
        },
      },
    },
  };

  await assert.rejects(
    dispatchOpenClawReplyWithBufferedBlockDispatcher(api, {
      ctx: { SenderId: 'kvictor' },
      cfg: {},
      hostDispatchConfig: { commands: { ownerAllowFrom: ['kvictor'] } },
      dispatcherOptions: { async deliver() {} },
    }),
    /dispatchReplyFromConfig API is unavailable/,
  );
});
