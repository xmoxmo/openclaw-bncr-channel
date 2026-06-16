import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import type { BncrRoute } from '../../core/types.ts';
import type {
  OpenClawChannelPeer,
  OpenClawChannelRuntimeContext,
} from '../../openclaw/channel-runtime-contracts.ts';
import type {
  BncrChannelConfigRoot,
  BncrChannelConfigSection,
} from '../../plugin/channel-runtime-types.ts';
import type { ReplyPayloadInput } from '../outbound/reply-enqueue.ts';
import type { OutboundReplyTargetPolicy } from '../outbound/reply-target-policy.ts';

export type BncrInboundParsedPeer = OpenClawChannelPeer;

export type BncrInboundParamsInput = {
  accountId?: unknown;
  platform?: unknown;
  groupId?: unknown;
  userId?: unknown;
  sessionKey?: unknown;
  originatingTo?: unknown;
  providedOriginatingTo?: unknown;
  to?: unknown;
  clientId?: unknown;
  msg?: unknown;
  type?: unknown;
  base64?: unknown;
  path?: unknown;
  mimeType?: unknown;
  fileName?: unknown;
  msgId?: unknown;
};

export type BncrRememberSessionRoute = (
  sessionKey: string,
  accountId: string,
  route: BncrRoute,
) => void;

export type BncrEnqueueFromReply = (args: {
  accountId: string;
  sessionKey: string;
  route: BncrRoute;
  payload: ReplyPayloadInput;
  mediaLocalRoots?: readonly string[];
  replyTargetPolicy?: OutboundReplyTargetPolicy;
}) => Promise<void>;

export type BncrInboundLogger = { warn?: (msg: string) => void; error?: (msg: string) => void };

export type BncrInboundApi = OpenClawPluginApi;

export type BncrInboundConfig = BncrChannelConfigRoot & {
  session?: { store?: string; dmScope?: unknown };
  channels?: Record<string, BncrChannelConfigSection | undefined>;
  agents?: {
    defaults?: {
      blockStreamingDefault?: unknown;
      blockStreamingBreak?: unknown;
      blockStreamingChunk?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  accessGroups?: unknown;
  [key: string]: unknown;
};

export type BncrInboundContextPayload = OpenClawChannelRuntimeContext;
