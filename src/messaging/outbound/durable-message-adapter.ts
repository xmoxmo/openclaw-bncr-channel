import { defineChannelMessageAdapter } from 'openclaw/plugin-sdk/channel-message';
import type {
  ChannelMessageAdapterShape,
  ChannelMessageSendMediaContext,
  ChannelMessageSendPayloadContext,
  ChannelMessageSendResult,
  ChannelMessageSendTextContext,
} from 'openclaw/plugin-sdk/channel-message';

import { buildFileTransferOutboxEntry, buildTextOutboxEntry } from '../../core/outbox-entry-builders.ts';
import type { BncrRoute, OutboxEntry } from '../../core/types.ts';
import { buildBncrDurableQueuedResult } from './durable-queue-adapter.ts';

export type BncrDurableMessageQueuedAdapterDeps<TConfig = unknown> = {
  enqueueText: (ctx: ChannelMessageSendTextContext<TConfig>) => Promise<OutboxEntry> | OutboxEntry;
  enqueueMedia?: (ctx: ChannelMessageSendMediaContext<TConfig>) => Promise<OutboxEntry> | OutboxEntry;
  enqueuePayload?: (ctx: ChannelMessageSendPayloadContext<TConfig>) => Promise<OutboxEntry> | OutboxEntry;
  now?: () => number;
};

export type BncrDurableMessageQueuedAdapterBuilderDeps<TConfig = unknown> = {
  createMessageId: () => string;
  now: () => number;
  normalizeAccountId: (accountId?: string | null) => string;
  normalizeReplyToId: (value?: string | null) => string;
  resolveTarget: (ctx: ChannelMessageSendTextContext<TConfig>) => {
    route: BncrRoute;
    sessionKey: string;
    accountId?: string | null;
  };
  filePushEvent?: string;
};

// This adapter intentionally models only the OpenClaw -> bncr-plugin handoff.
// Once a message is accepted into bncr's own outbox, OpenClaw should stop managing it;
// client/platform ACK, retry, and deadLetter remain owned by the bncr service framework.
export function createBncrDurableMessageQueuedAdapter<TConfig = unknown>(
  deps: BncrDurableMessageQueuedAdapterDeps<TConfig>,
): ChannelMessageAdapterShape<TConfig, ChannelMessageSendResult> {
  return defineChannelMessageAdapter({
    id: 'bncr-queued-outbox',
    receive: {
      defaultAckPolicy: 'manual',
      supportedAckPolicies: ['manual'],
    },
    send: {
      text: async (ctx) => toChannelMessageSendResult(await deps.enqueueText(ctx), deps.now),
      media: deps.enqueueMedia
        ? async (ctx) => toChannelMessageSendResult(await deps.enqueueMedia?.(ctx), deps.now)
        : undefined,
      payload: deps.enqueuePayload
        ? async (ctx) => toChannelMessageSendResult(await deps.enqueuePayload?.(ctx), deps.now)
        : undefined,
    },
  });
}

export function createBncrDurableMessageQueuedAdapterFromBuilders<TConfig = unknown>(
  deps: BncrDurableMessageQueuedAdapterBuilderDeps<TConfig>,
): ChannelMessageAdapterShape<TConfig, ChannelMessageSendResult> {
  return createBncrDurableMessageQueuedAdapter<TConfig>({
    now: deps.now,
    enqueueText: (ctx) => {
      const resolved = deps.resolveTarget(ctx);
      return buildTextOutboxEntry({
        createMessageId: deps.createMessageId,
        now: deps.now,
        normalizeAccountId: deps.normalizeAccountId,
        normalizeReplyToId: deps.normalizeReplyToId,
        accountId: resolved.accountId ?? ctx.accountId ?? undefined,
        sessionKey: resolved.sessionKey,
        route: resolved.route,
        text: ctx.text,
        kind: 'final',
        replyToId: ctx.replyToId ?? undefined,
      });
    },
    enqueueMedia: (ctx) => {
      const resolved = deps.resolveTarget(ctx);
      return buildFileTransferOutboxEntry({
        createMessageId: deps.createMessageId,
        now: deps.now,
        normalizeAccountId: deps.normalizeAccountId,
        pushEvent: deps.filePushEvent ?? 'bncr.file.push',
        accountId: resolved.accountId ?? ctx.accountId ?? undefined,
        sessionKey: resolved.sessionKey,
        route: resolved.route,
        mediaUrl: ctx.mediaUrl,
        mediaLocalRoots: ctx.mediaLocalRoots,
        text: ctx.text,
        asVoice: ctx.audioAsVoice,
        audioAsVoice: ctx.audioAsVoice,
        kind: 'final',
        replyToId: ctx.replyToId ?? undefined,
      });
    },
  });
}

function toChannelMessageSendResult(entry: OutboxEntry | undefined, now?: () => number): ChannelMessageSendResult {
  if (!entry) throw new Error('bncr durable message adapter did not receive an outbox entry');
  const queued = buildBncrDurableQueuedResult({ entry, sentAt: now?.() });
  return {
    receipt: queued.receipt as any,
    messageId: queued.receipt.primaryPlatformMessageId,
  };
}
