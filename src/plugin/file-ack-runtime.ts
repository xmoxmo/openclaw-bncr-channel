import { buildFileAckKey } from '../core/file-ack.ts';
import { OUTBOUND_TERMINAL_REASON } from '../messaging/outbound/reasons.ts';

export type FileAckPayloadState = {
  payload: Record<string, unknown>;
  ok: boolean;
  at: number;
};

export type FileAckWaiter = {
  promise: Promise<Record<string, unknown>>;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export function createBncrFileAckRuntime(runtime: {
  bridgeId: string;
  now: () => number;
  asString: (value: unknown, fallback?: string) => string;
  clampFiniteNumber: (value: unknown, fallback: number, min?: number, max?: number) => number;
  fileAckTimeoutMs: number;
  maxEarlyFileAcks: number;
  fileAckWaiters: Map<string, FileAckWaiter>;
  earlyFileAcks: Map<string, FileAckPayloadState>;
  getFileAckOwnerInfo: (transferId: string) => Record<string, unknown>;
  logInfo: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  logWarn: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
}) {
  function rememberEarlyFileAck(key: string, state: FileAckPayloadState) {
    runtime.earlyFileAcks.set(key, state);
    while (runtime.earlyFileAcks.size > runtime.maxEarlyFileAcks) {
      const oldestKey = runtime.earlyFileAcks.keys().next().value;
      if (!oldestKey) break;
      runtime.earlyFileAcks.delete(oldestKey);
    }
  }

  function fileAckKey(transferId: string, stage: string, chunkIndex?: number): string {
    return buildFileAckKey({ transferId, stage, chunkIndex });
  }

  function buildFileAckWaitContext(params: {
    transferId: string;
    stage: string;
    chunkIndex?: number;
    timeoutMs?: number;
  }) {
    const transferId = runtime.asString(params.transferId).trim();
    const stage = runtime.asString(params.stage).trim();
    const chunkIndex = Number.isFinite(Number(params.chunkIndex))
      ? Number(params.chunkIndex)
      : undefined;
    return {
      transferId,
      stage,
      chunkIndex,
      key: fileAckKey(transferId, stage, params.chunkIndex),
      timeoutMs: runtime.clampFiniteNumber(
        params.timeoutMs,
        runtime.fileAckTimeoutMs,
        1_000,
        120_000,
      ),
      ownerInfo: runtime.getFileAckOwnerInfo(transferId),
    };
  }

  function settleFileAckWaiter(
    waiter: {
      resolve: (payload: Record<string, unknown>) => void;
      reject: (err: Error) => void;
    },
    payload: Record<string, unknown>,
    ok: boolean,
  ) {
    if (ok) {
      waiter.resolve(payload);
      return;
    }
    waiter.reject(
      new Error(runtime.asString(payload?.errorMessage || payload?.error || 'file ack failed')),
    );
  }

  function consumeEarlyFileAck(ack: {
    transferId: string;
    stage: string;
    chunkIndex?: number;
    key: string;
    ownerInfo: Record<string, unknown>;
  }): Promise<Record<string, unknown>> | null {
    const cached = runtime.earlyFileAcks.get(ack.key);
    if (!cached) return null;
    runtime.earlyFileAcks.delete(ack.key);
    runtime.logInfo(
      'file-ack-cache-hit',
      JSON.stringify({
        bridge: runtime.bridgeId,
        transferId: ack.transferId,
        stage: ack.stage,
        ackStage: ack.stage,
        ackOutcome: cached.ok ? 'acked' : 'failed',
        waiterReused: false,
        chunkIndex: ack.chunkIndex,
        key: ack.key,
        ...ack.ownerInfo,
        ok: cached.ok,
        payload: cached.payload,
      }),
      { debugOnly: true },
    );
    if (cached.ok) return Promise.resolve(cached.payload);
    return Promise.reject(
      new Error(
        runtime.asString(
          cached.payload?.errorMessage || cached.payload?.error || 'file ack failed',
        ),
      ),
    );
  }

  function waitForFileAck(params: {
    transferId: string;
    stage: string;
    chunkIndex?: number;
    timeoutMs?: number;
  }) {
    const ack = buildFileAckWaitContext(params);

    const cached = consumeEarlyFileAck(ack);
    if (cached) return cached;

    const existing = runtime.fileAckWaiters.get(ack.key);
    if (existing) {
      runtime.logWarn(
        'file-ack-waiter-reuse',
        JSON.stringify({
          bridge: runtime.bridgeId,
          transferId: ack.transferId,
          stage: ack.stage,
          ackStage: ack.stage,
          ackOutcome: 'waiter-reused',
          waiterReused: true,
          chunkIndex: ack.chunkIndex,
          key: ack.key,
          ...ack.ownerInfo,
        }),
        { debugOnly: true },
      );
      return existing.promise;
    }

    runtime.logInfo(
      'file-ack-wait',
      JSON.stringify({
        bridge: runtime.bridgeId,
        transferId: ack.transferId,
        stage: ack.stage,
        ackStage: ack.stage,
        ackOutcome: 'waiting',
        waiterReused: false,
        chunkIndex: ack.chunkIndex,
        key: ack.key,
        ...ack.ownerInfo,
        timeoutMs: ack.timeoutMs,
      }),
      { debugOnly: true },
    );

    let timer: NodeJS.Timeout;
    let resolveWaiter!: (payload: Record<string, unknown>) => void;
    let rejectWaiter!: (err: Error) => void;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
      timer = setTimeout(() => {
        runtime.fileAckWaiters.delete(ack.key);
        runtime.logWarn(
          OUTBOUND_TERMINAL_REASON.FILE_ACK_TIMEOUT,
          JSON.stringify({
            bridge: runtime.bridgeId,
            transferId: ack.transferId,
            stage: ack.stage,
            ackStage: ack.stage,
            ackOutcome: 'timeout',
            waiterReused: false,
            chunkIndex: ack.chunkIndex,
            key: ack.key,
            ...ack.ownerInfo,
            timeoutMs: ack.timeoutMs,
          }),
          { debugOnly: true },
        );
        reject(new Error(`file ack timeout: ${ack.key}`));
      }, ack.timeoutMs);
    });
    runtime.fileAckWaiters.set(ack.key, {
      promise,
      resolve: resolveWaiter,
      reject: rejectWaiter,
      timer: timer!,
    });
    return promise;
  }

  function resolveFileAck(params: {
    transferId: string;
    stage: string;
    chunkIndex?: number;
    payload: Record<string, unknown>;
    ok: boolean;
  }) {
    const ack = buildFileAckWaitContext(params);
    const waiter = runtime.fileAckWaiters.get(ack.key);
    if (!waiter) {
      rememberEarlyFileAck(ack.key, {
        payload: params.payload,
        ok: params.ok,
        at: runtime.now(),
      });
      runtime.logInfo(
        'file-ack-early-cache',
        JSON.stringify({
          bridge: runtime.bridgeId,
          transferId: ack.transferId,
          stage: ack.stage,
          ackStage: ack.stage,
          ackOutcome: params.ok ? 'early-acked' : 'early-failed',
          waiterReused: false,
          chunkIndex: ack.chunkIndex,
          key: ack.key,
          ...ack.ownerInfo,
          ok: params.ok,
          payload: params.payload,
          cached: true,
        }),
        { debugOnly: true },
      );
      return false;
    }
    runtime.fileAckWaiters.delete(ack.key);
    clearTimeout(waiter.timer);
    runtime.logInfo(
      'file-ack-resolve',
      JSON.stringify({
        bridge: runtime.bridgeId,
        transferId: ack.transferId,
        stage: ack.stage,
        ackStage: ack.stage,
        ackOutcome: params.ok ? 'acked' : 'failed',
        waiterReused: false,
        chunkIndex: ack.chunkIndex,
        key: ack.key,
        ...ack.ownerInfo,
        ok: params.ok,
        payload: params.payload,
      }),
      { debugOnly: true },
    );
    settleFileAckWaiter(waiter, params.payload, params.ok);
    return true;
  }

  function clearAllFileAckWaiters(reason: string) {
    for (const waiter of runtime.fileAckWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    runtime.fileAckWaiters.clear();
    runtime.earlyFileAcks.clear();
  }

  return {
    rememberEarlyFileAck,
    fileAckKey,
    buildFileAckWaitContext,
    consumeEarlyFileAck,
    settleFileAckWaiter,
    waitForFileAck,
    resolveFileAck,
    clearAllFileAckWaiters,
  };
}
