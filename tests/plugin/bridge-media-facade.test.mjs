import assert from 'node:assert/strict';
import test from 'node:test';

import { createBncrBridgeMediaFacade } from '../../src/plugin/bridge-media-facade.ts';

test('bridge media facade preserves route selection, orchestrator delegation, and reply logging', async () => {
  const logs = [];
  const replyCalls = [];
  const facade = createBncrBridgeMediaFacade({
    api: {},
    resolveOutboundFileName: ({ fileName }) => fileName || 'fallback.bin',
    outboxRoute: {
      buildTransferRouteDiagnostics: (args) => ({ ...args, kind: 'diag' }),
      selectTransferConnIds: ({ directConnIds }) => new Set(directConnIds),
    },
    fileTransferOrchestrator: {
      waitChunkAck: async (params) => params,
      waitCompleteAck: async () => ({ path: '/tmp/a.png' }),
      transferMediaToBncrClient: async () => ({
        mode: 'base64',
        fileName: 'a.png',
        mediaBase64: 'Zm9v',
      }),
    },
    replyMediaOrchestrator: {
      enqueueFromReply: (params) => replyCalls.push(['fromReply', params]),
    },
    logInfoJson: (scope, event, payload) => logs.push([scope, event, payload]),
    buildEnqueueFromReplyDebugInfo: (args) => ({
      accountId: args.accountId,
      sessionKey: args.sessionKey,
    }),
    fileTransferLogs: {
      logFileChunkDiag: (args) => logs.push(['chunk', args]),
      logFileTransferStart: (args) => logs.push(['start', args]),
      logFileTransferChunkSend: (args) => logs.push(['send', args]),
      logFileTransferChunkAck: (args) => logs.push(['ack', args]),
      logFileTransferChunkAckFail: (args) => logs.push(['ack-fail', args]),
      logFileTransferCompleteSend: (args) => logs.push(['complete-send', args]),
      logFileTransferCompleteAck: (args) => logs.push(['complete-ack', args]),
      buildInitialFileSendTransferState: (args) => ({
        ...args,
        normalized: args.normalizeAccountId(args.accountId),
      }),
    },
    normalizeAccountId: (accountId) => String(accountId || '').trim(),
  });

  assert.deepEqual(
    facade.buildTransferRouteDiagnostics({ accountId: 'Primary', recentInboundReachable: true }),
    { accountId: 'Primary', recentInboundReachable: true, kind: 'diag' },
  );
  assert.deepEqual(
    Array.from(
      facade.selectTransferConnIds({
        directConnIds: new Set(['c1']),
        recentConnIds: new Set(['c2']),
        recentInboundReachable: true,
      }),
    ),
    ['c1'],
  );
  assert.deepEqual(await facade.waitCompleteAck({ transferId: 't1' }), { path: '/tmp/a.png' });
  assert.deepEqual(
    await facade.transferMediaToBncrClient({
      accountId: 'Primary',
      sessionKey: 's1',
      route: { platform: 'tgBot', groupId: '0', userId: '10001' },
      mediaUrl: 'https://example.com/a.png',
    }),
    {
      mode: 'base64',
      fileName: 'a.png',
      mediaBase64: 'Zm9v',
    },
  );

  facade.enqueueFromReply({
    accountId: 'Primary',
    sessionKey: 's1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: 'hello' },
  });
  facade.logEnqueueFromReply({
    accountId: 'Primary',
    sessionKey: 's1',
    route: { platform: 'tgBot', groupId: '0', userId: '10001' },
    payload: { text: 'hello' },
  });

  assert.equal(replyCalls.length, 1);
  assert.equal(logs[0][1], 'enqueue-from-reply');
});
