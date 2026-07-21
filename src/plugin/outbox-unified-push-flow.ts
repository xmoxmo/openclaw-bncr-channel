import {
  buildFileTransferPushOkArgs,
  buildFileTransferPushSuccessArgs,
} from '../core/outbox-file-transfer-bookkeeping.ts';
import { resolveFileTransferGuard } from '../core/outbox-file-transfer-guards.ts';
import {
  prepareRouteSelection,
  prepareRouteSelection as prepareTextPushRouteSelection,
} from '../core/outbox-file-transfer-prep.ts';
import {
  buildFileTransferBroadcastPayload,
  buildFileTransferRouteSelectArgs,
} from '../core/outbox-file-transfer-success.ts';
import { resolveTextPushGuard } from '../core/outbox-text-push-guards.ts';
import {
  buildTextPushBroadcastPayload,
  buildTextPushOkArgs,
  buildTextPushRouteSelectArgs,
  buildTextPushSuccessArgs,
} from '../core/outbox-text-push-success.ts';
import type { BncrConnection, BncrRoute, OutboxEntry } from '../core/types.ts';
import { isPlainObject } from '../core/value-sanitize.ts';
import {
  selectOutboxFileTransferRouteCandidates,
  selectOutboxRouteCandidates,
} from '../messaging/outbound/queue-selectors.ts';

type FileTransferGuardFailure = {
  reason: 'media-url-missing' | 'no-gateway-context' | 'no-active-connection';
  lastError: string;
  recentInboundReachable?: boolean;
};

export type RunBncrOutboxPushArgs = {
  entry: OutboxEntry;
  gatewayContext: unknown;
  owner: BncrConnection | null;
  resolvePushConnIds: (accountId: string) => Set<string>;
  resolveRecentInboundConnIds: (accountId: string) => Set<string>;
  hasRecentInboundReachability: (accountId: string) => boolean;
  isRevalidatedAttemptedConn: (connId: string) => boolean;
  // Route + guard failure
  recordOutboxPrePushFailure: (args: {
    entry: OutboxEntry;
    lastError: string;
    persist?: boolean;
  }) => void;
  logOutboxPushSkip: (args: {
    messageId: string;
    accountId: string;
    reason: string;
    recentInboundReachable?: boolean;
    routeReason?: string;
    connIds?: Iterable<string>;
    ownerConnId?: string;
    ownerClientId?: string;
  }) => void;
  handleFileTransferPushGuardFailure: (args: {
    entry: OutboxEntry;
    guard: FileTransferGuardFailure & { ok: false };
  }) => void;
  // Broadcast + bookkeeping (unified)
  pushEvent: string;
  gatewayBroadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
  ) => void;
  recordOutboxPushSuccess: (args: {
    entry: OutboxEntry;
    connIds: Iterable<string>;
    ownerConnId?: string;
    ownerClientId?: string;
  }) => void;
  logOutboxRouteSelect: (args: {
    messageId: string;
    accountId: string;
    kind?: 'file-transfer';
    routeReason: string;
    connIds: Iterable<string>;
    ownerConnId: string;
    ownerClientId: string;
    recentInboundReachable: boolean;
    event: string;
  }) => void;
  logOutboxPushOkSummary: (messageId: string) => void;
  logOutboundSummary: (entry: OutboxEntry) => void;
  logOutboxPushOk: (args: {
    messageId: string;
    accountId: string;
    kind?: 'file-transfer';
    connIds: Iterable<string>;
    ownerConnId: string;
    ownerClientId: string;
    recentInboundReachable: boolean;
    event: string;
  }) => void;
  // Failure handlers
  handleTextPushFailure: (args: { entry: OutboxEntry; error: unknown }) => void;
  handleFileTransferPushFailure: (args: { entry: OutboxEntry; error: unknown }) => void;
  // Media-specific (optional)
  transferMediaToBncrClient?: (params: {
    accountId: string;
    sessionKey: string;
    route: BncrRoute;
    mediaUrl: string;
    mediaLocalRoots?: readonly string[];
    downloadMedia?: boolean;
  }) => Promise<{
    mode: 'base64' | 'chunk';
    mimeType?: string;
    fileName?: string;
    base64?: string;
    path?: string;
  }>;
  buildFileTransferOutboundFrame?: (params: {
    entry: OutboxEntry;
    msg: Record<string, unknown>;
    media: { fileName?: string; mimeType?: string; path?: string; base64?: string; type?: string };
    mediaUrl: string;
  }) => Record<string, unknown>;
};

export async function runBncrOutboxPush(args: RunBncrOutboxPushArgs): Promise<boolean> {
  const entry = args.entry;
  const msg =
    isPlainObject(entry.payload) &&
    isPlainObject((entry.payload as Record<string, unknown>).message)
      ? ((entry.payload as Record<string, unknown>).message as Record<string, unknown>)
      : null;
  const transferMode = msg?.transferMode === 'media' ? 'media' : 'text';

  // Route selection
  const selection =
    transferMode === 'media'
      ? prepareRouteSelection({
          entry,
          owner: args.owner,
          resolvePushConnIds: args.resolvePushConnIds,
          resolveRecentInboundConnIds: args.resolveRecentInboundConnIds,
          hasRecentInboundReachability: args.hasRecentInboundReachability,
          isRevalidatedAttemptedConn: args.isRevalidatedAttemptedConn,
          selectRouteCandidates: selectOutboxFileTransferRouteCandidates,
        })
      : prepareTextPushRouteSelection({
          entry,
          owner: args.owner,
          resolvePushConnIds: args.resolvePushConnIds,
          resolveRecentInboundConnIds: args.resolveRecentInboundConnIds,
          hasRecentInboundReachability: args.hasRecentInboundReachability,
          isRevalidatedAttemptedConn: args.isRevalidatedAttemptedConn,
          selectRouteCandidates: selectOutboxRouteCandidates,
        });

  // Guard + dispatch
  if (transferMode === 'media') {
    const guard = resolveFileTransferGuard({
      gatewayContext: args.gatewayContext,
      entry,
      owner: args.owner,
      routeSelection: selection,
      mediaUrl: String(msg!.mediaUrl || '').trim(),
    });
    if (!guard.ok) {
      args.handleFileTransferPushGuardFailure({
        entry,
        guard: guard as FileTransferGuardFailure & { ok: false },
      });
      return false;
    }

    // ── Media success path (inline) ──
    try {
      const media = await args.transferMediaToBncrClient!({
        accountId: entry.accountId,
        sessionKey: entry.sessionKey,
        route: entry.route,
        mediaUrl: guard.mediaUrl,
        mediaLocalRoots: Array.isArray(msg!.mediaLocalRoots)
          ? (msg!.mediaLocalRoots as readonly string[])
          : undefined,
        downloadMedia: msg!.downloadMedia as boolean | undefined,
      });
      const frame = args.buildFileTransferOutboundFrame!({
        entry,
        msg: msg!,
        media,
        mediaUrl: guard.mediaUrl,
      });

      args.gatewayBroadcastToConnIds(
        args.pushEvent,
        buildFileTransferBroadcastPayload({ frame, messageId: entry.messageId }),
        new Set(guard.connIds),
      );
      args.logOutboxRouteSelect(
        buildFileTransferRouteSelectArgs({
          entry,
          connIds: guard.connIds,
          routeReason: guard.routeReason,
          recentInboundReachable: guard.recentInboundReachable,
          owner: args.owner,
          event: args.pushEvent,
        }),
      );
      args.recordOutboxPushSuccess(
        buildFileTransferPushSuccessArgs({
          entry,
          connIds: guard.connIds,
          owner: args.owner,
        }),
      );
      args.logOutboxPushOkSummary(entry.messageId);
      // Sync entry type from the resolved frame
      const frameMsg = frame?.message as Record<string, unknown> | undefined;
      if (frameMsg?.type !== undefined) {
        (msg! as Record<string, unknown>).type = frameMsg.type;
      }
      args.logOutboundSummary(entry);
      args.logOutboxPushOk(
        buildFileTransferPushOkArgs({
          entry,
          connIds: guard.connIds,
          recentInboundReachable: guard.recentInboundReachable,
          event: args.pushEvent,
        }),
      );
      return true;
    } catch (error) {
      args.handleFileTransferPushFailure({ entry, error });
      return false;
    }
  }

  // ── Text ──
  const textGuard = resolveTextPushGuard({
    gatewayContext: args.gatewayContext,
    entry,
    routeSelection: selection,
  });
  if (!textGuard.ok) {
    args.recordOutboxPrePushFailure({
      entry,
      lastError:
        textGuard.reason === 'no-gateway-context'
          ? 'gateway context unavailable'
          : 'no active bncr client',
      persist: true,
    });
    args.logOutboxPushSkip({
      messageId: entry.messageId,
      accountId: entry.accountId,
      reason: textGuard.reason,
      recentInboundReachable:
        textGuard.reason === 'no-active-connection' ? textGuard.recentInboundReachable : undefined,
      routeReason: selection.routeReason,
      connIds: selection.connIds,
      ownerConnId: selection.ownerConnId,
      ownerClientId: args.owner?.clientId,
    });
    return false;
  }

  // ── Text success path (inline) ──
  try {
    args.gatewayBroadcastToConnIds(
      args.pushEvent,
      buildTextPushBroadcastPayload({
        payload: entry.payload,
        messageId: entry.messageId,
      }),
      new Set(textGuard.connIds),
    );
    args.logOutboxRouteSelect(
      buildTextPushRouteSelectArgs({
        entry,
        connIds: textGuard.connIds,
        routeReason: textGuard.routeReason,
        recentInboundReachable: textGuard.recentInboundReachable,
        owner: args.owner,
        event: args.pushEvent,
      }),
    );
    args.recordOutboxPushSuccess(
      buildTextPushSuccessArgs({
        entry,
        connIds: textGuard.connIds,
        ownerConnId: textGuard.ownerConnId,
        ownerClientId: textGuard.ownerConnId ? args.owner?.clientId : undefined,
      }),
    );
    args.logOutboxPushOkSummary(entry.messageId);
    args.logOutboundSummary(entry);
    args.logOutboxPushOk(
      buildTextPushOkArgs({
        entry,
        connIds: textGuard.connIds,
        recentInboundReachable: textGuard.recentInboundReachable,
        event: args.pushEvent,
      }),
    );
    return true;
  } catch (error) {
    args.handleTextPushFailure({ entry, error });
    return false;
  }
}
