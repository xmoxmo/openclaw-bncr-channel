import type { BncrConnection } from '../core/types.ts';

export function createBncrTransientStateRuntime(runtime: {
  now: () => number;
  connectTtlMs: number;
  fileTransferKeepMs: number;
  fileTransferTerminalKeepMs: number;
  fileTransferAckTtlMs: number;
  connections: Map<string, BncrConnection>;
  activeConnectionByAccount: Map<string, string>;
  recentInbound: Map<string, number>;
  fileSendTransfers: Map<string, { status: string; startedAt: number; terminalAt?: number }>;
  fileRecvTransfers: Map<string, { status: string; startedAt: number; terminalAt?: number }>;
  earlyFileAcks: Map<string, { at: number }>;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  bridgeId: string;
}) {
  function cleanupFileTransfers() {
    const t = runtime.now();
    const keepMsForTransfer = (st: { status: string; startedAt: number; terminalAt?: number }) => {
      const startedAt = Number.isFinite(st.startedAt) ? st.startedAt : t;
      if (st.status === 'completed' || st.status === 'aborted') {
        return {
          since: Number.isFinite(st.terminalAt) ? (st.terminalAt as number) : startedAt,
          keepMs: runtime.fileTransferTerminalKeepMs,
        };
      }
      return { since: startedAt, keepMs: runtime.fileTransferKeepMs };
    };

    for (const [id, st] of runtime.fileSendTransfers.entries()) {
      const keep = keepMsForTransfer(st);
      if (t - keep.since > keep.keepMs) runtime.fileSendTransfers.delete(id);
    }
    for (const [id, st] of runtime.fileRecvTransfers.entries()) {
      const keep = keepMsForTransfer(st);
      if (t - keep.since > keep.keepMs) runtime.fileRecvTransfers.delete(id);
    }
    for (const [key, ack] of runtime.earlyFileAcks.entries()) {
      if (t - ack.at > runtime.fileTransferAckTtlMs) runtime.earlyFileAcks.delete(key);
    }
  }

  function gcTransientState() {
    const t = runtime.now();
    const staleBefore = t - runtime.connectTtlMs * 2;

    for (const [key, c] of runtime.connections.entries()) {
      if (c.lastSeenAt < staleBefore) {
        runtime.logInfo(
          'connection',
          `gc ${JSON.stringify({
            bridge: runtime.bridgeId,
            key,
            accountId: c.accountId,
            connId: c.connId,
            clientId: c.clientId,
            lastSeenAt: c.lastSeenAt,
            staleBefore,
          })}`,
          { debugOnly: true },
        );
        runtime.connections.delete(key);
        if (runtime.activeConnectionByAccount.get(c.accountId) === key) {
          runtime.activeConnectionByAccount.delete(c.accountId);
        }
      }
    }

    const dedupWindowMs = 90_000;
    for (const [key, ts] of runtime.recentInbound.entries()) {
      if (t - ts > dedupWindowMs) runtime.recentInbound.delete(key);
    }

    cleanupFileTransfers();
  }

  return {
    gcTransientState,
    cleanupFileTransfers,
  };
}
