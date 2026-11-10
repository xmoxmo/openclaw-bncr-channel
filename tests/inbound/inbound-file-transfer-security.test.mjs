import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import test from 'node:test';

import { cleanupBridge, createBridge, recvKey } from '../helpers/bncr-bridge.mjs';

function sessionKey(userId = 'security-user') {
  return `agent:orion:bncr:direct:${Buffer.from(`tgBot:0:${userId}`).toString('hex')}`;
}

async function initiate(bridge, overrides = {}) {
  let result;
  await bridge.handleFileInit({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      transferId: 'transfer-a',
      sessionKey: sessionKey(),
      platform: 'tgBot',
      groupId: '0',
      userId: 'security-user',
      fileName: 'security.txt',
      mimeType: 'text/plain',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
      fileSha256: '',
      ...overrides,
    },
    respond(ok, payload) {
      result = { ok, payload };
    },
    client: { connId: overrides.connId || 'conn-1' },
    context: null,
  });
  return result;
}

async function sendChunk(bridge, overrides = {}) {
  let result;
  await bridge.handleFileChunk({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      transferId: 'transfer-a',
      chunkIndex: 0,
      offset: 0,
      base64: Buffer.from('hello').toString('base64'),
      ...overrides,
    },
    respond(ok, payload) {
      result = { ok, payload };
    },
    client: { connId: overrides.connId || 'conn-1' },
    context: null,
  });
  return result;
}

async function completeTransfer(bridge, overrides = {}) {
  let result;
  await bridge.handleFileComplete({
    params: {
      accountId: 'Primary',
      clientId: 'client-a',
      transferId: 'transfer-a',
      ...overrides,
    },
    respond(ok, payload) {
      result = { ok, payload };
    },
    client: { connId: overrides.connId || 'conn-1' },
    context: null,
  });
  return result;
}

test('file.init enforces chunk, count, active-transfer, and account-byte budgets', async () => {
  const bridge = createBridge();
  try {
    const oversizedChunk = await initiate(bridge, {
      transferId: 'oversized-chunk',
      fileSize: 1024 * 1024 + 1,
      chunkSize: 1024 * 1024 + 1,
      totalChunks: 1,
    });
    assert.equal(oversizedChunk.ok, false);
    assert.match(oversizedChunk.payload.error, /chunkSize too large/);

    const oversizedCount = await initiate(bridge, {
      transferId: 'oversized-count',
      fileSize: 32_769,
      chunkSize: 1,
      totalChunks: 32_769,
    });
    assert.equal(oversizedCount.ok, false);
    assert.match(oversizedCount.payload.error, /totalChunks too large/);

    for (let index = 0; index < 4; index += 1) {
      const accepted = await initiate(bridge, {
        transferId: `active-${index}`,
        fileSize: 1,
        chunkSize: 1,
        totalChunks: 1,
      });
      assert.equal(accepted.ok, true);
    }
    const accountLimited = await initiate(bridge, {
      transferId: 'active-5',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
    });
    assert.equal(accountLimited.ok, false);
    assert.match(accountLimited.payload.error, /too many active inbound transfers account=Primary/);
  } finally {
    cleanupBridge(bridge);
  }

  const globalBridge = createBridge();
  try {
    for (const accountId of ['Primary', 'Secondary']) {
      for (let index = 0; index < 4; index += 1) {
        const accepted = await initiate(globalBridge, {
          accountId,
          transferId: `${accountId}-${index}`,
          fileSize: 1,
          chunkSize: 1,
          totalChunks: 1,
        });
        assert.equal(accepted.ok, true);
      }
    }
    const globallyLimited = await initiate(globalBridge, {
      accountId: 'Tertiary',
      transferId: 'global-limit',
      fileSize: 1,
      chunkSize: 1,
      totalChunks: 1,
    });
    assert.equal(globallyLimited.ok, false);
    assert.match(globallyLimited.payload.error, /too many active inbound transfers/);
  } finally {
    cleanupBridge(globalBridge);
  }

  const budgetBridge = createBridge({ config: { channels: { bncr: { mediaMaxMb: 1 } } } });
  try {
    const first = await initiate(budgetBridge, {
      transferId: 'budget-1',
      fileSize: 600_000,
      chunkSize: 600_000,
      totalChunks: 1,
    });
    assert.equal(first.ok, true);
    const second = await initiate(budgetBridge, {
      transferId: 'budget-2',
      fileSize: 600_000,
      chunkSize: 600_000,
      totalChunks: 1,
    });
    assert.equal(second.ok, false);
    assert.match(second.payload.error, /account inbound transfer budget exceeded/);
  } finally {
    cleanupBridge(budgetBridge);
  }
});

test('file metadata limits reject unbounded identifiers, hashes, and abort reasons', async () => {
  const bridge = createBridge();
  try {
    const longTransfer = await initiate(bridge, { transferId: 'x'.repeat(257) });
    assert.equal(longTransfer.ok, false);
    assert.match(longTransfer.payload.error, /transferId too long/);

    const malformedFileHash = await initiate(bridge, { fileSha256: 'not-a-sha256' });
    assert.equal(malformedFileHash.ok, false);
    assert.match(malformedFileHash.payload.error, /fileSha256 must be 64 hexadecimal/);

    const longRoute = await initiate(bridge, { userId: 'x'.repeat(513) });
    assert.equal(longRoute.ok, false);
    assert.match(longRoute.payload.error, /route field too long/);

    const init = await initiate(bridge, { transferId: 'metadata-limits' });
    assert.equal(init.ok, true);
    const malformedChunkHash = await sendChunk(bridge, {
      transferId: 'metadata-limits',
      chunkSha256: 'x'.repeat(65),
    });
    assert.equal(malformedChunkHash.ok, false);
    assert.match(malformedChunkHash.payload.error, /chunkSha256 must be 64 hexadecimal/);

    let abortResult;
    await bridge.handleFileAbort({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'metadata-limits',
        reason: 'x'.repeat(513),
      },
      respond(ok, payload) {
        abortResult = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });
    assert.equal(abortResult.ok, false);
    assert.match(abortResult.payload.error, /abort reason too long/);
    assert.equal(
      bridge.fileRecvTransfers.get(recvKey('Primary', 'metadata-limits')).status,
      'init',
    );
  } finally {
    cleanupBridge(bridge);
  }
});

test('file.chunk validates declared size, offset, decoded size, and duplicate semantics', async () => {
  const bridge = createBridge();
  try {
    const init = await initiate(bridge, {
      transferId: 'chunk-rules',
      fileSize: 6,
      chunkSize: 5,
      totalChunks: 2,
    });
    assert.equal(init.ok, true);

    const first = await sendChunk(bridge, {
      transferId: 'chunk-rules',
      chunkIndex: 0,
      offset: 0,
      base64: Buffer.from('hello').toString('base64'),
    });
    assert.equal(first.ok, true);
    assert.equal(first.payload.received, 1);

    const duplicate = await sendChunk(bridge, {
      transferId: 'chunk-rules',
      chunkIndex: 0,
      offset: 0,
      base64: Buffer.from('hello').toString('base64'),
    });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.payload.duplicated, true);

    const conflicting = await sendChunk(bridge, {
      transferId: 'chunk-rules',
      chunkIndex: 0,
      offset: 0,
      base64: Buffer.from('HELLO').toString('base64'),
    });
    assert.equal(conflicting.ok, false);
    assert.match(conflicting.payload.error, /already received with different content/);

    const wrongOffset = await sendChunk(bridge, {
      transferId: 'chunk-rules',
      chunkIndex: 1,
      offset: 0,
      base64: Buffer.from('!').toString('base64'),
    });
    assert.equal(wrongOffset.ok, false);
    assert.match(wrongOffset.payload.error, /chunk offset mismatch/);

    const wrongDeclaredSize = await sendChunk(bridge, {
      transferId: 'chunk-rules',
      chunkIndex: 1,
      offset: 5,
      size: 2,
      base64: Buffer.from('!').toString('base64'),
    });
    assert.equal(wrongDeclaredSize.ok, false);
    assert.match(wrongDeclaredSize.payload.error, /chunk size mismatch expected=1 got=2/);

    const oversizedBase64 = await sendChunk(bridge, {
      transferId: 'chunk-rules',
      chunkIndex: 1,
      offset: 5,
      base64: Buffer.from('!!').toString('base64'),
    });
    assert.equal(oversizedBase64.ok, false);
    assert.match(oversizedBase64.payload.error, /base64 too large/);

    const last = await sendChunk(bridge, {
      transferId: 'chunk-rules',
      chunkIndex: 1,
      offset: 5,
      base64: Buffer.from('!').toString('base64'),
    });
    assert.equal(last.ok, true);

    const complete = await completeTransfer(bridge, { transferId: 'chunk-rules' });
    assert.equal(complete.ok, true);
    const state = bridge.fileRecvTransfers.get(recvKey('Primary', 'chunk-rules'));
    assert.equal(state.status, 'completed');
    assert.equal(state.stagingPath, undefined);
    assert.equal(state.receivedChunks.size, 0);
    assert.equal(state.receivedChunkDigests.size, 0);
    assert.equal('bufferByChunk' in state, false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('missing or current leases never bypass transfer ownership checks', async () => {
  const bridge = createBridge();
  try {
    const init = await initiate(bridge, { transferId: 'owner-check' });
    assert.equal(init.ok, true);

    const missingLeaseOtherConn = await sendChunk(bridge, {
      transferId: 'owner-check',
      connId: 'conn-2',
      clientId: 'client-b',
    });
    assert.equal(missingLeaseOtherConn.ok, false);
    assert.equal(missingLeaseOtherConn.payload.error, 'transfer not found');

    bridge.primaryLeaseId = 'current-lease';
    bridge.connectionEpoch = 7;
    const currentLeaseOtherConn = await sendChunk(bridge, {
      transferId: 'owner-check',
      connId: 'conn-3',
      clientId: 'client-c',
      leaseId: 'current-lease',
      connectionEpoch: 7,
    });
    assert.equal(currentLeaseOtherConn.ok, false);
    assert.equal(currentLeaseOtherConn.payload.error, 'transfer not found');

    const sameClientOtherConnComplete = await completeTransfer(bridge, {
      transferId: 'owner-check',
      connId: 'conn-3',
      clientId: 'client-a',
      leaseId: 'current-lease',
      connectionEpoch: 7,
    });
    assert.equal(sameClientOtherConnComplete.ok, false);
    assert.equal(sameClientOtherConnComplete.payload.error, 'transfer not found');

    let abortResult;
    await bridge.handleFileAbort({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'owner-check',
        reason: 'unauthorized abort',
        leaseId: 'current-lease',
        connectionEpoch: 7,
      },
      respond(ok, payload) {
        abortResult = { ok, payload };
      },
      client: { connId: 'conn-3' },
      context: null,
    });
    assert.equal(abortResult.ok, false);
    assert.equal(abortResult.payload.error, 'transfer not found');

    bridge.primaryLeaseId = 'newer-lease';
    bridge.connectionEpoch = 8;
    const ownerWithoutLease = await sendChunk(bridge, { transferId: 'owner-check' });
    assert.equal(ownerWithoutLease.ok, true);
    assert.equal(ownerWithoutLease.payload.received, 1);

    const state = bridge.fileRecvTransfers.get(recvKey('Primary', 'owner-check'));
    assert.equal(state.receivedChunks.size, 1);
  } finally {
    cleanupBridge(bridge);
  }
});

test('account isolation hides terminal state and allows independent same transferIds', async () => {
  const bridge = createBridge();
  try {
    const primary = await initiate(bridge, { transferId: 'shared-id' });
    assert.equal(primary.ok, true);
    const primaryChunk = await sendChunk(bridge, { transferId: 'shared-id' });
    assert.equal(primaryChunk.ok, true);
    const primaryComplete = await completeTransfer(bridge, { transferId: 'shared-id' });
    assert.equal(primaryComplete.ok, true);
    assert.match(primaryComplete.payload.path, /security\.txt/);

    const secondaryTerminalProbe = await sendChunk(bridge, {
      accountId: 'Secondary',
      transferId: 'shared-id',
      connId: 'conn-secondary',
      clientId: 'client-secondary',
    });
    assert.equal(secondaryTerminalProbe.ok, false);
    assert.equal(secondaryTerminalProbe.payload.error, 'transfer not found');
    assert.equal(Object.hasOwn(secondaryTerminalProbe.payload, 'path'), false);

    const secondary = await initiate(bridge, {
      accountId: 'Secondary',
      transferId: 'shared-id',
      connId: 'conn-secondary',
      clientId: 'client-secondary',
    });
    assert.equal(secondary.ok, true);
    assert.notEqual(
      bridge.fileRecvTransfers.get(recvKey('Primary', 'shared-id')),
      bridge.fileRecvTransfers.get(recvKey('Secondary', 'shared-id')),
    );
  } finally {
    cleanupBridge(bridge);
  }
});

test('file.init is idempotent only for the same owner and declaration', async () => {
  const bridge = createBridge();
  try {
    const first = await initiate(bridge, { transferId: 'idempotent-init' });
    assert.equal(first.ok, true);

    const retry = await initiate(bridge, { transferId: 'idempotent-init' });
    assert.equal(retry.ok, true);
    assert.equal(retry.payload.duplicated, true);

    const conflicting = await initiate(bridge, {
      transferId: 'idempotent-init',
      fileName: 'different.txt',
    });
    assert.equal(conflicting.ok, false);
    assert.match(conflicting.payload.error, /different transfer parameters/);
  } finally {
    cleanupBridge(bridge);
  }
});

test('abort removes staging and completed states retain no file content', async () => {
  const bridge = createBridge();
  try {
    const init = await initiate(bridge, { transferId: 'abort-cleanup' });
    assert.equal(init.ok, true);
    const state = bridge.fileRecvTransfers.get(recvKey('Primary', 'abort-cleanup'));
    const stagingPath = state.stagingPath;
    assert.equal(existsSync(stagingPath), true);

    let abortResult;
    await bridge.handleFileAbort({
      params: {
        accountId: 'Primary',
        clientId: 'client-a',
        transferId: 'abort-cleanup',
        reason: 'test abort',
      },
      respond(ok, payload) {
        abortResult = { ok, payload };
      },
      client: { connId: 'conn-1' },
      context: null,
    });
    assert.equal(abortResult.ok, true);
    assert.equal(state.stagingPath, undefined);
    assert.equal(state.receivedChunks.size, 0);
    assert.equal(state.receivedChunkDigests.size, 0);
    assert.equal(existsSync(stagingPath), false);
    assert.equal('bufferByChunk' in state, false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('concurrent file.init requests serialize quota admission', async () => {
  const bridge = createBridge();
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        initiate(bridge, {
          transferId: `concurrent-${index}`,
          fileSize: 1,
          chunkSize: 1,
          totalChunks: 1,
        }),
      ),
    );
    assert.equal(results.filter((result) => result.ok).length, 4);
    assert.equal(
      results.filter((result) => result.ok === false).length,
      4,
      'the account quota should reject everything beyond four active transfers',
    );
  } finally {
    cleanupBridge(bridge);
  }
});

test('per-transfer operations have a bounded queue and release the slot when settled', async () => {
  const bridge = createBridge();
  try {
    const init = await initiate(bridge, {
      transferId: 'operation-queue',
      fileSize: 25,
      chunkSize: 5,
      totalChunks: 5,
    });
    assert.equal(init.ok, true);
    const key = recvKey('Primary', 'operation-queue');
    const state = bridge.fileRecvTransfers.get(key);
    let releaseGate;
    state.operationTail = new Promise((resolve) => {
      releaseGate = resolve;
    });

    const requests = Array.from({ length: 5 }, (_, index) =>
      sendChunk(bridge, {
        transferId: 'operation-queue',
        chunkIndex: index,
        offset: index * 5,
        base64: Buffer.alloc(5, 0x61 + index).toString('base64'),
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.pendingOperations, 4);

    releaseGate();
    const results = await Promise.all(requests);
    assert.equal(results.filter((result) => result.ok).length, 4);
    assert.equal(
      results.filter((result) => result.ok === false && result.payload.error === 'transfer busy')
        .length,
      1,
    );
    assert.equal(state.pendingOperations, 0);

    const last = await sendChunk(bridge, {
      transferId: 'operation-queue',
      chunkIndex: 4,
      offset: 20,
      base64: Buffer.alloc(5, 0x65).toString('base64'),
    });
    assert.equal(last.ok, true);
    const complete = await completeTransfer(bridge, { transferId: 'operation-queue' });
    assert.equal(complete.ok, true);
  } finally {
    cleanupBridge(bridge);
  }
});

test('idle cleanup removes the active transfer and its staging file', async () => {
  const bridge = createBridge();
  try {
    const init = await initiate(bridge, {
      transferId: 'idle-cleanup',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
    });
    assert.equal(init.ok, true);
    const key = recvKey('Primary', 'idle-cleanup');
    const state = bridge.fileRecvTransfers.get(key);
    const stagingPath = state.stagingPath;
    state.lastChunkAt = Date.now() - 6 * 60_000;
    state.startedAt = Date.now() - 10 * 60_000;
    assert.equal(existsSync(stagingPath), true);

    bridge.cleanupFileTransfers();

    assert.equal(bridge.fileRecvTransfers.has(key), false);
    assert.equal(existsSync(stagingPath), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('hard TTL defers cleanup while a transfer operation is pending', async () => {
  const bridge = createBridge();
  try {
    const init = await initiate(bridge, {
      transferId: 'hard-ttl-pending',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
    });
    assert.equal(init.ok, true);
    const key = recvKey('Primary', 'hard-ttl-pending');
    const state = bridge.fileRecvTransfers.get(key);
    const stagingPath = state.stagingPath;
    state.lastChunkAt = Date.now() - 7 * 60 * 60_000;
    state.startedAt = Date.now() - 7 * 60 * 60_000;
    state.pendingOperations = 1;

    bridge.cleanupFileTransfers();

    assert.equal(bridge.fileRecvTransfers.has(key), true);
    assert.equal(existsSync(stagingPath), true);

    state.pendingOperations = 0;
    bridge.cleanupFileTransfers();

    assert.equal(bridge.fileRecvTransfers.has(key), false);
    assert.equal(existsSync(stagingPath), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('an expired transfer is not revived by a later chunk or complete request', async () => {
  const bridge = createBridge();
  try {
    const init = await initiate(bridge, { transferId: 'expired-no-revival' });
    assert.equal(init.ok, true);
    const key = recvKey('Primary', 'expired-no-revival');
    const state = bridge.fileRecvTransfers.get(key);
    const stagingPath = state.stagingPath;
    state.lastChunkAt = Date.now() - 6 * 60_000;
    state.startedAt = Date.now() - 10 * 60_000;

    const chunk = await sendChunk(bridge, { transferId: 'expired-no-revival' });
    assert.equal(chunk.ok, false);
    assert.equal(chunk.payload.error, 'transfer not found');
    assert.equal(bridge.fileRecvTransfers.has(key), false);
    assert.equal(existsSync(stagingPath), false);

    const complete = await completeTransfer(bridge, { transferId: 'expired-no-revival' });
    assert.equal(complete.ok, false);
    assert.equal(complete.payload.error, 'transfer not found');
    assert.equal(bridge.fileRecvTransfers.has(key), false);
  } finally {
    cleanupBridge(bridge);
  }
});

test('a queued chunk cannot mutate a replacement transfer that reuses the same id', async () => {
  const bridge = createBridge();
  let oldStagingPath;
  try {
    const init = await initiate(bridge, { transferId: 'aba-transfer' });
    assert.equal(init.ok, true);
    const key = recvKey('Primary', 'aba-transfer');
    const oldState = bridge.fileRecvTransfers.get(key);
    oldStagingPath = oldState.stagingPath;

    let releaseOldOperation;
    oldState.operationTail = new Promise((resolve) => {
      releaseOldOperation = resolve;
    });
    const queuedChunk = sendChunk(bridge, { transferId: 'aba-transfer' });
    await new Promise((resolve) => setImmediate(resolve));

    bridge.fileRecvTransfers.delete(key);
    const replacement = await initiate(bridge, {
      transferId: 'aba-transfer',
      connId: 'conn-2',
      clientId: 'client-b',
    });
    assert.equal(replacement.ok, true);
    const replacementState = bridge.fileRecvTransfers.get(key);
    assert.notEqual(replacementState, oldState);

    releaseOldOperation();
    const staleResult = await queuedChunk;
    assert.equal(staleResult.ok, false);
    assert.equal(staleResult.payload.error, 'transfer not found');
    assert.equal(replacementState.status, 'init');
    assert.equal(replacementState.receivedChunks.size, 0);
    assert.equal(replacementState.receivedChunkDigests.size, 0);
  } finally {
    if (oldStagingPath && existsSync(oldStagingPath)) unlinkSync(oldStagingPath);
    cleanupBridge(bridge);
  }
});

test('256 KiB chunk framing still completes through the streaming path', async () => {
  const bridge = createBridge();
  const chunkSize = 256 * 1024;
  const first = Buffer.alloc(chunkSize, 0x61);
  const second = Buffer.from('tail');
  const payload = Buffer.concat([first, second]);
  const fileSha256 = createHash('sha256').update(payload).digest('hex');
  try {
    const init = await initiate(bridge, {
      transferId: 'normal-framing',
      fileSize: payload.length,
      chunkSize,
      totalChunks: 2,
      fileSha256,
    });
    assert.equal(init.ok, true);

    const firstResult = await sendChunk(bridge, {
      transferId: 'normal-framing',
      chunkIndex: 0,
      offset: 0,
      size: chunkSize,
      base64: first.toString('base64'),
    });
    assert.equal(firstResult.ok, true);

    const secondResult = await sendChunk(bridge, {
      transferId: 'normal-framing',
      chunkIndex: 1,
      offset: chunkSize,
      size: second.length,
      base64: second.toString('base64'),
    });
    assert.equal(secondResult.ok, true);

    const complete = await completeTransfer(bridge, { transferId: 'normal-framing' });
    assert.equal(complete.ok, true);
    assert.equal(complete.payload.size, payload.length);
    assert.equal(complete.payload.fileSha256, fileSha256);
  } finally {
    cleanupBridge(bridge);
  }
});

test('shutdown removes all active staging files and runtime transfer state', async () => {
  const bridge = createBridge();
  try {
    const init = await initiate(bridge, {
      transferId: 'shutdown-cleanup',
      fileSize: 5,
      chunkSize: 5,
      totalChunks: 1,
    });
    assert.equal(init.ok, true);
    const state = bridge.fileRecvTransfers.get(recvKey('Primary', 'shutdown-cleanup'));
    const stagingPath = state.stagingPath;
    assert.equal(existsSync(stagingPath), true);

    bridge.shutdown();

    assert.equal(existsSync(stagingPath), false);
    assert.equal(bridge.fileRecvTransfers.size, 0);
  } finally {
    cleanupBridge(bridge);
  }
});
