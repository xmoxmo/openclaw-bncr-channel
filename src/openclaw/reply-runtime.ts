import type {
  OpenClawChannelRuntimeApiHolder,
  OpenClawChannelRuntimeContext,
  OpenClawReplyDispatcherPayload,
  OpenClawReplyDispatchInfo,
} from './channel-runtime-contracts.ts';

function resolveReplyApi(api: OpenClawChannelRuntimeApiHolder): Record<string, unknown> {
  const reply = api?.runtime?.channel?.reply;
  if (!reply || typeof reply !== 'object') {
    throw new Error('OpenClaw channel reply API is unavailable');
  }
  return reply as Record<string, unknown>;
}

export function resolveOpenClawEnvelopeFormatOptions(
  api: OpenClawChannelRuntimeApiHolder,
  cfg: unknown,
): unknown {
  const reply = resolveReplyApi(api);
  const resolveEnvelopeFormatOptions = reply.resolveEnvelopeFormatOptions;
  if (typeof resolveEnvelopeFormatOptions !== 'function') {
    throw new Error('OpenClaw channel reply resolveEnvelopeFormatOptions API is unavailable');
  }
  return resolveEnvelopeFormatOptions(cfg);
}

export function formatOpenClawAgentEnvelope(
  api: OpenClawChannelRuntimeApiHolder,
  params: {
    channel: string;
    from: string;
    timestamp: number;
    previousTimestamp?: unknown;
    envelope?: unknown;
    body: string;
  },
): string {
  const reply = resolveReplyApi(api);
  const formatAgentEnvelope = reply.formatAgentEnvelope as
    | ((params: {
        channel: string;
        from: string;
        timestamp: number;
        previousTimestamp?: unknown;
        envelope?: unknown;
        body: string;
      }) => string)
    | undefined;
  if (typeof formatAgentEnvelope !== 'function') {
    throw new Error('OpenClaw channel reply formatAgentEnvelope API is unavailable');
  }
  return formatAgentEnvelope(params);
}

export async function dispatchOpenClawReplyWithBufferedBlockDispatcher(
  api: OpenClawChannelRuntimeApiHolder,
  params: {
    ctx: OpenClawChannelRuntimeContext;
    cfg: unknown;
    dispatcherOptions: {
      deliver: (
        payload: OpenClawReplyDispatcherPayload,
        info?: OpenClawReplyDispatchInfo,
      ) => Promise<void> | void;
      onError?: (err: unknown) => void;
    };
    replyOptions?: {
      disableBlockStreaming?: boolean;
      shouldEmitToolResult?: () => boolean;
    };
  },
): Promise<unknown> {
  const reply = resolveReplyApi(api);
  const dispatchReplyWithBufferedBlockDispatcher = reply.dispatchReplyWithBufferedBlockDispatcher as
    | ((params: {
        ctx: OpenClawChannelRuntimeContext;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (
            payload: OpenClawReplyDispatcherPayload,
            info?: OpenClawReplyDispatchInfo,
          ) => Promise<void> | void;
          onError?: (err: unknown) => void;
        };
        replyOptions?: {
          disableBlockStreaming?: boolean;
          shouldEmitToolResult?: () => boolean;
        };
      }) => Promise<unknown> | unknown)
    | undefined;
  if (typeof dispatchReplyWithBufferedBlockDispatcher !== 'function') {
    throw new Error(
      'OpenClaw channel reply dispatchReplyWithBufferedBlockDispatcher API is unavailable',
    );
  }
  return dispatchReplyWithBufferedBlockDispatcher(params);
}
