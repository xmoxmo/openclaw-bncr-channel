import { createHash } from 'node:crypto';
import { normalizeAccountId } from '../../core/accounts.ts';
import { extractInlineTaskKey } from '../../core/targets.ts';
import type { BncrRoute } from '../../core/types.ts';
import { asBoolean, asString, asStringArray } from '../../core/value-sanitize.ts';
import type { BncrInboundMediaItem, BncrInboundParamsInput } from './contracts.ts';

function asInboundMediaItems(params: BncrInboundParamsInput): BncrInboundMediaItem[] {
  const normalized: BncrInboundMediaItem[] = [];
  const rawList = Array.isArray(params?.mediaList) ? params.mediaList : [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const path = asString((item as { path?: unknown }).path || '').trim();
    const base64 = asString((item as { base64?: unknown }).base64 || '').trim();
    const mimeType = asString((item as { mimeType?: unknown }).mimeType || '').trim();
    const fileName = asString((item as { fileName?: unknown }).fileName || '').trim();
    const type = asString((item as { type?: unknown }).type || '').trim();
    const transferId = asString((item as { transferId?: unknown }).transferId || '').trim();
    if (!path && !base64) continue;
    normalized.push({
      ...(path ? { path } : {}),
      ...(base64 ? { base64 } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(fileName ? { fileName } : {}),
      ...(type ? { type } : {}),
      ...(transferId ? { transferId } : {}),
    });
  }

  if (normalized.length > 0) return normalized;

  const legacyPath = asString(params?.path || '').trim();
  const legacyBase64 = asString(params?.base64 || '').trim();
  const legacyMimeType = asString(params?.mimeType || '').trim();
  const legacyFileName = asString(params?.fileName || '').trim();
  const legacyType = asString(params?.type || '').trim();
  const legacyTransferId = asString((params as { transferId?: unknown })?.transferId || '').trim();
  if (legacyPath || legacyBase64) {
    return [
      {
        ...(legacyPath ? { path: legacyPath } : {}),
        ...(legacyBase64 ? { base64: legacyBase64 } : {}),
        ...(legacyMimeType ? { mimeType: legacyMimeType } : {}),
        ...(legacyFileName ? { fileName: legacyFileName } : {}),
        ...(legacyType ? { type: legacyType } : {}),
        ...(legacyTransferId ? { transferId: legacyTransferId } : {}),
      },
    ];
  }

  const legacyPaths = asStringArray(params?.paths);
  return legacyPaths.map((item) => ({
    path: item,
    ...(legacyMimeType ? { mimeType: legacyMimeType } : {}),
    ...(legacyFileName ? { fileName: legacyFileName } : {}),
    ...(legacyType ? { type: legacyType } : {}),
    ...(legacyTransferId ? { transferId: legacyTransferId } : {}),
  }));
}

function inboundDedupKey(params: {
  accountId: string;
  platform: string;
  groupId: string;
  userId: string;
  msgId?: string;
  text?: string;
  mediaBase64?: string;
}): string {
  const accountId = normalizeAccountId(params.accountId);
  const platform = asString(params.platform).trim().toLowerCase();
  const groupId = asString(params.groupId).trim();
  const userId = asString(params.userId).trim();
  const msgId = asString(params.msgId || '').trim();

  if (msgId) return `${accountId}|${platform}|${groupId}|${userId}|msg:${msgId}`;

  const text = asString(params.text || '').trim();
  const media = asString(params.mediaBase64 || '');
  const digest = createHash('sha1')
    .update(`${text}\n${media.slice(0, 256)}`)
    .digest('hex')
    .slice(0, 16);
  return `${accountId}|${platform}|${groupId}|${userId}|hash:${digest}`;
}

export function resolveChatType(route: BncrRoute, isGroup: boolean): 'direct' | 'group' {
  if (isGroup) return 'group';
  if (route.groupId !== '0') return 'group';
  return 'direct';
}

export function parseBncrInboundParams(params: BncrInboundParamsInput) {
  const accountId = normalizeAccountId(asString(params?.accountId || ''));
  const protocolVersion = asString(params?.protocolVersion || '').trim() || undefined;
  const capabilities = asStringArray(params?.capabilities);
  const platform = asString(params?.platform || '').trim();
  const groupId = asString(params?.groupId || '0').trim() || '0';
  const groupName = asString(params?.groupName || '').trim();
  const userId = asString(params?.userId || '').trim();
  const userName = asString(params?.userName || '').trim();
  const sessionKeyfromroute = asString(params?.sessionKey || '').trim();
  const providedOriginatingTo =
    asString(params?.originatingTo || params?.providedOriginatingTo || params?.to || '').trim() ||
    undefined;
  const clientId = asString(params?.clientId || '').trim() || undefined;
  const bridgeId = asString(params?.bridgeId || params?.clientId || '').trim() || undefined;
  const bridgeName = asString(params?.bridgeName || 'Bncr').trim() || 'Bncr';
  const isGroup = asBoolean(params?.isGroup, groupId !== '0');
  const isAdmin = asBoolean(params?.isAdmin, false);

  const route: BncrRoute = {
    platform,
    groupId,
    userId,
  };

  const text = asString(params?.msg || '');
  const msgType = asString(params?.type || 'text') || 'text';
  const mediaItems = asInboundMediaItems(params);
  const mediaBase64 = asString(params?.base64 || '');
  const mediaPathFromTransfer = asString(params?.path || '').trim();
  const mimeType = asString(params?.mimeType || '').trim() || undefined;
  const fileName = asString(params?.fileName || '').trim() || undefined;
  const msgId = asString(params?.msgId || '').trim() || undefined;
  const shouldRespond = asBoolean(params?.shouldRespond, false);
  const triggerKind = asString(params?.triggerKind || 'none').trim() || 'none';
  const botName = asString(params?.botName || '').trim();
  const isBotMentioned = asBoolean(params?.isBotMentioned, false);
  const isReplyToBot = asBoolean(params?.isReplyToBot, false);

  const dedupKey = inboundDedupKey({
    accountId,
    platform,
    groupId,
    userId,
    msgId,
    text,
    mediaBase64,
  });

  const peerKind = resolveChatType(route, isGroup);
  const peer = {
    kind: peerKind,
    id: peerKind === 'group' ? route.groupId : route.userId,
  } as const;

  const extracted = extractInlineTaskKey(text);

  return {
    accountId,
    protocolVersion,
    capabilities,
    platform,
    groupId,
    groupName,
    userId,
    userName,
    sessionKeyfromroute,
    providedOriginatingTo,
    clientId,
    bridgeId,
    bridgeName,
    isGroup,
    isAdmin,
    route,
    text,
    msgType,
    mediaItems,
    mediaBase64,
    mediaPathFromTransfer,
    mimeType,
    fileName,
    msgId,
    shouldRespond,
    triggerKind,
    botName,
    isBotMentioned,
    isReplyToBot,
    dedupKey,
    peer,
    extracted,
  };
}
