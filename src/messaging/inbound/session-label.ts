import { emitBncrLogLine } from '../../core/logging.ts';
import { formatHumanDisplayScope, parseRouteFromDisplayScope } from '../../core/targets.ts';
import type { OpenClawChannelRuntimeContext } from '../../openclaw/channel-runtime-contracts.ts';
import {
  recordBncrSessionMetaFromInbound,
  updateBncrSessionStoreEntry,
} from '../../openclaw/inbound-session-runtime.ts';

function formatBncrSessionLabel(displayTo: string): string {
  const raw = String(displayTo || '').trim();
  const route = parseRouteFromDisplayScope(raw);
  if (route) return formatHumanDisplayScope(route);
  return raw;
}

function formatBncrSessionRouteTarget(displayTo: string): string {
  const raw = String(displayTo || '').trim();
  const parts = raw.split(':');
  if (parts.length === 4 && parts[0] === 'Bncr') {
    const [, platform, groupId, userId] = parts;
    if (platform && groupId && groupId !== '0') return `Bncr:${platform}:${groupId}:0`;
    if (platform && userId && userId !== '0') return `Bncr:${platform}:0:${userId}`;
  }
  return raw;
}

function formatBncrSessionGroupKey(displayTo: string): string | null {
  const raw = String(displayTo || '').trim();
  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== 'Bncr') return null;
  const [, platform, groupId] = parts;
  if (!platform || !groupId || groupId === '0') return null;
  return `${platform.toLowerCase()}:${groupId}`;
}

type RecordInboundSessionFn = (args: {
  storePath?: string;
  sessionKey?: string;
  [key: string]: unknown;
}) => Promise<unknown> | unknown;

type SessionStoreEntryLike = { label?: string | null; [key: string]: unknown };

export function buildBncrInboundSessionIdentityPatch(args: {
  channelId: string;
  accountId: string;
  chatType: 'direct' | 'group';
  displayTo: string;
  senderId: string;
}) {
  const { channelId, accountId, chatType, displayTo, senderId } = args;
  const displayLabel = formatBncrSessionLabel(displayTo);
  const routeTarget = formatBncrSessionRouteTarget(displayTo);
  const groupKey = chatType === 'group' ? formatBncrSessionGroupKey(displayTo) : null;
  return {
    label: displayLabel,
    displayName: displayLabel,
    channel: channelId,
    chatType,
    ...(groupKey ? { groupId: groupKey } : {}),
    origin: {
      label: displayLabel,
      provider: channelId,
      surface: channelId,
      chatType,
      from: senderId,
      to: routeTarget,
      accountId,
    },
    deliveryContext: {
      channel: channelId,
      to: routeTarget,
      accountId,
    },
    route: {
      channel: channelId,
      accountId,
      target: { to: routeTarget },
    },
    lastTo: routeTarget,
  };
}

function normalizeNonEmptyString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export async function correctBncrInboundSessionLabel(args: {
  storePath: string;
  sessionKey: string;
  expectedPatch: Record<string, unknown>;
}) {
  const storePath = normalizeNonEmptyString(args.storePath);
  const sessionKey = normalizeNonEmptyString(args.sessionKey);
  if (!storePath || !sessionKey) return;

  const expectedPatch = args.expectedPatch;
  const expectedLabel = normalizeNonEmptyString(expectedPatch.label);
  const expectedDisplayName = normalizeNonEmptyString(expectedPatch.displayName);
  const expectedGroupId = normalizeNonEmptyString(expectedPatch.groupId);
  const expectedOriginTo = normalizeNonEmptyString(
    (expectedPatch.origin as { to?: unknown } | undefined)?.to,
  );
  const expectedDeliveryTo = normalizeNonEmptyString(
    (expectedPatch.deliveryContext as { to?: unknown } | undefined)?.to,
  );
  const expectedRouteTo = normalizeNonEmptyString(
    (
      (expectedPatch.route as { target?: { to?: unknown } } | undefined)?.target as
        | { to?: unknown }
        | undefined
    )?.to,
  );
  const expectedLastTo = normalizeNonEmptyString(expectedPatch.lastTo);
  if (
    !expectedLabel ||
    !expectedDisplayName ||
    !expectedOriginTo ||
    !expectedDeliveryTo ||
    !expectedRouteTo ||
    !expectedLastTo
  )
    return;

  try {
    await updateBncrSessionStoreEntry({
      storePath,
      sessionKey,
      update: (entry: SessionStoreEntryLike) => {
        const origin =
          entry?.origin && typeof entry.origin === 'object'
            ? (entry.origin as Record<string, unknown>)
            : {};
        const deliveryContext =
          entry?.deliveryContext && typeof entry.deliveryContext === 'object'
            ? (entry.deliveryContext as Record<string, unknown>)
            : {};
        const route =
          entry?.route && typeof entry.route === 'object'
            ? (entry.route as Record<string, unknown>)
            : {};
        const routeTarget =
          route.target && typeof route.target === 'object'
            ? (route.target as Record<string, unknown>)
            : {};

        const unchanged =
          entry?.label === expectedLabel &&
          entry?.displayName === expectedDisplayName &&
          normalizeNonEmptyString(entry?.groupId) === expectedGroupId &&
          normalizeNonEmptyString(origin.to) === expectedOriginTo &&
          normalizeNonEmptyString(deliveryContext.to) === expectedDeliveryTo &&
          normalizeNonEmptyString(routeTarget.to) === expectedRouteTo &&
          normalizeNonEmptyString(entry?.lastTo) === expectedLastTo;
        if (unchanged) return null;

        return {
          ...(expectedGroupId ? { groupId: expectedGroupId } : {}),
          label: expectedLabel,
          displayName: expectedDisplayName,
          origin: {
            ...origin,
            ...(expectedPatch.origin as Record<string, unknown>),
          },
          deliveryContext: {
            ...deliveryContext,
            ...(expectedPatch.deliveryContext as Record<string, unknown>),
          },
          route: {
            ...route,
            ...(expectedPatch.route as Record<string, unknown>),
            target: {
              to: expectedRouteTo,
            },
          },
          lastTo: expectedLastTo,
        };
      },
    });
  } catch (err) {
    emitBncrLogLine('warn', `[bncr] inbound session label correction failed: ${String(err)}`);
  }
}

export async function recordAndPatchBncrInboundSessionEntry(args: {
  storePath: string;
  sessionKey: string;
  ctx?: OpenClawChannelRuntimeContext;
  patch: Record<string, unknown>;
}) {
  const storePath = normalizeNonEmptyString(args.storePath);
  const sessionKey = normalizeNonEmptyString(args.sessionKey);
  if (!storePath || !sessionKey) return;

  try {
    if (args.ctx) {
      await recordBncrSessionMetaFromInbound({
        storePath,
        sessionKey,
        ctx: args.ctx,
        createIfMissing: true,
      });
    }
    await updateBncrSessionStoreEntry({
      storePath,
      sessionKey,
      update: () => args.patch,
    });
  } catch (err) {
    emitBncrLogLine('warn', `[bncr] inbound session patch failed: ${String(err)}`);
  }
}

export function wrapBncrInboundRecordSessionLabelCorrection(args: {
  recordInboundSession: RecordInboundSessionFn;
  expectedPatch: Record<string, unknown>;
}): RecordInboundSessionFn {
  return async (recordArgs) => {
    const result = await args.recordInboundSession(recordArgs);
    if (!recordArgs?.storePath || !recordArgs?.sessionKey) return result;
    await correctBncrInboundSessionLabel({
      storePath: recordArgs.storePath,
      sessionKey: recordArgs.sessionKey,
      expectedPatch: args.expectedPatch,
    });
    return result;
  };
}
