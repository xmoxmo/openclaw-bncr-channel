import type { BncrRoute } from './accounts.ts';

export function buildFileTransferInitPayload(args: {
  transferId: string;
  sessionKey: string;
  route: BncrRoute;
  fileName: string;
  mimeType?: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  fileSha256: string;
  ts: number;
}) {
  return {
    transferId: args.transferId,
    direction: 'oc2bncr' as const,
    sessionKey: args.sessionKey,
    platform: args.route.platform,
    groupId: args.route.groupId,
    userId: args.route.userId,
    fileName: args.fileName,
    mimeType: args.mimeType,
    fileSize: args.fileSize,
    chunkSize: args.chunkSize,
    totalChunks: args.totalChunks,
    fileSha256: args.fileSha256,
    ts: args.ts,
  };
}

export function buildFileTransferChunkPayload(args: {
  transferId: string;
  chunkIndex: number;
  offset: number;
  size: number;
  chunkSha256: string;
  base64: string;
  ts: number;
}) {
  return {
    transferId: args.transferId,
    chunkIndex: args.chunkIndex,
    offset: args.offset,
    size: args.size,
    chunkSha256: args.chunkSha256,
    base64: args.base64,
    ts: args.ts,
  };
}

export function buildFileTransferAbortPayload(args: {
  transferId: string;
  reason: string;
  ts: number;
}) {
  return {
    transferId: args.transferId,
    reason: args.reason,
    ts: args.ts,
  };
}

export function buildFileTransferCompletePayload(args: {
  transferId: string;
  ts: number;
}) {
  return {
    transferId: args.transferId,
    ts: args.ts,
  };
}
