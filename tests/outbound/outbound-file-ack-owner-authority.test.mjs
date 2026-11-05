import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupBridge, createBridge } from '../helpers/bncr-bridge.mjs';

function setTransfer(bridge, args = {}) {
  const transferId = args.transferId || 'transfer-owner-authority';
  bridge.fileSendTransfers.set(transferId, {
    transferId,
    accountId: args.accountId || 'Primary',
    sessionKey: 'agent:orion:bncr:direct:demo',
    route: { platform: 'tgBot', groupId: '-1001', userId: '10001' },
    fileName: 'demo.png',
    mimeType: 'image/png',
    fileSize: 1,
    chunkSize: 1,
    totalChunks: 1,
    fileSha256: 'sha',
    ackedChunks: new Set(),
    failedChunks: new Map(),
    status: 'transferring',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(args.ownerConnId ? { ownerConnId: args.ownerConnId } : {}),
    ...(args.ownerClientId ? { ownerClientId: args.ownerClientId } : {}),
  });
  return transferId;
}

async function sendCompleteAck(bridge, args) {
  let response = null;
  await bridge.handleFileAck({
    params: {
      accountId: args.accountId || 'Primary',
      clientId: args.clientId,
      transferId: args.transferId,
      stage: 'complete',
      ok: true,
      path: '/tmp/owner-authorized.png',
    },
    respond(ok, payload) {
      response = { ok, payload };
    },
    client: { connId: args.connId },
    context: null,
  });
  return response;
}

test('file ACK from a different connection cannot mutate state or wake the owner waiter', async () => {
  const bridge = createBridge();

  try {
    const transferId = setTransfer(bridge, {
      ownerConnId: 'conn-owner',
      ownerClientId: 'client-owner',
    });
    const waiter = bridge.waitCompleteAck({ transferId, timeoutMs: 1_000 });

    const denied = await sendCompleteAck(bridge, {
      transferId,
      connId: 'conn-intruder',
      clientId: 'client-intruder',
    });

    assert.equal(denied.ok, true);
    assert.equal(denied.payload.ignored, true);
    assert.equal(bridge.fileAckWaiters.size, 1);
    assert.equal(bridge.fileSendTransfers.get(transferId).status, 'transferring');

    const accepted = await sendCompleteAck(bridge, {
      transferId,
      connId: 'conn-owner',
      clientId: 'client-owner',
    });

    assert.equal(accepted.ok, true);
    assert.equal(accepted.payload.state, 'completed');
    assert.deepEqual(await waiter, { path: '/tmp/owner-authorized.png' });
  } finally {
    cleanupBridge(bridge);
  }
});

test('file ACK rejects a matching owner connection in another account', async () => {
  const bridge = createBridge();

  try {
    const transferId = setTransfer(bridge, {
      ownerConnId: 'conn-owner',
      ownerClientId: 'client-owner',
    });
    const waiter = bridge.waitCompleteAck({ transferId, timeoutMs: 1_000 });

    const denied = await sendCompleteAck(bridge, {
      transferId,
      accountId: 'Secondary',
      connId: 'conn-owner',
      clientId: 'client-owner',
    });

    assert.equal(denied.ok, false);
    assert.match(denied.payload.error, /account mismatch/i);
    assert.equal(bridge.fileAckWaiters.size, 1);
    assert.equal(bridge.fileSendTransfers.get(transferId).status, 'transferring');
    waiter.catch(() => {});
  } finally {
    cleanupBridge(bridge);
  }
});

test('file ACK fails closed when transfer state has no owner identity', async () => {
  const bridge = createBridge();

  try {
    const transferId = setTransfer(bridge);
    const response = await sendCompleteAck(bridge, {
      transferId,
      connId: 'conn-any',
      clientId: 'client-any',
    });

    assert.equal(response.ok, true);
    assert.equal(response.payload.ignored, true);
    assert.equal(bridge.fileSendTransfers.get(transferId).status, 'transferring');
    assert.equal(bridge.earlyFileAcks.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});
