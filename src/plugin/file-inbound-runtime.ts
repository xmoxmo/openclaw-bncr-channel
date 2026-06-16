import type { GatewayRequestHandlerOptions } from 'openclaw/plugin-sdk/core';
import type { BncrRoute, FileRecvTransferState } from '../core/types.ts';

export type BncrFileInboundLeaseEventKind =
  | 'file.init'
  | 'file.chunk'
  | 'file.complete'
  | 'file.abort';

export type BncrFileInboundRuntime = {
  asString: (value: unknown, fallback?: string) => string;
  now: () => number;
  normalizeAccountId: (accountId: string) => string;
  finiteNonNegativeNumberOrNull: (value: unknown) => number | null;
  shouldIgnoreStaleEvent: (args: {
    kind: BncrFileInboundLeaseEventKind;
    payload: Record<string, unknown>;
    accountId: string;
    connId: string;
    clientId?: string;
  }) => boolean;
  observeLease: (
    kind: BncrFileInboundLeaseEventKind,
    payload: Record<string, unknown>,
  ) => { stale: boolean };
  matchesTransferOwner: (args: {
    ownerConnId?: string;
    ownerClientId?: string;
    connId: string;
    clientId?: string;
  }) => boolean;
  refreshAcceptedFileTransferLiveState: (args: {
    accountId: string;
    connId: string;
    clientId?: string;
    context: GatewayRequestHandlerOptions['context'];
  }) => void;
  logWarn: (scope: string | undefined, message: string, options?: { debugOnly?: boolean }) => void;
  parseRouteLike: (args: { platform: string; groupId: string; userId: string }) => BncrRoute | null;
  normalizeStoredSessionKey: (
    sessionKey: string,
  ) => { sessionKey: string; route: BncrRoute } | null;
  saveInboundMediaBuffer: (args: {
    buffer: Buffer;
    mimeType: string;
    fileName: string;
  }) => Promise<{ path: string }>;
  fileRecvTransfers: Map<string, FileRecvTransferState>;
  inboundFileTransferMaxBytes: number;
  inboundFileTransferMaxChunks: number;
};
