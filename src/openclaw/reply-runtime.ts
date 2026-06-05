type RuntimeReplyApi = {
  formatAgentEnvelope?: (params: {
    channel: string;
    from: string;
    timestamp: number;
    previousTimestamp?: unknown;
    envelope?: unknown;
    body: string;
  }) => string;
  resolveEnvelopeFormatOptions?: (cfg: unknown) => unknown;
  dispatchReplyWithBufferedBlockDispatcher?: (params: {
    ctx: unknown;
    cfg: unknown;
    dispatcherOptions: {
      deliver: (
        payload: {
          text?: string;
          mediaUrl?: string;
          mediaUrls?: string[];
          audioAsVoice?: boolean;
        },
        info?: { kind?: 'tool' | 'block' | 'final' },
      ) => Promise<void> | void;
      onError?: (err: unknown) => void;
    };
    replyOptions?: {
      disableBlockStreaming?: boolean;
      shouldEmitToolResult?: () => boolean;
    };
  }) => Promise<unknown> | unknown;
};

type RuntimeApiHolder = {
  runtime?: {
    channel?: {
      reply?: RuntimeReplyApi;
    };
  };
};

function resolveReplyApi(api: RuntimeApiHolder): RuntimeReplyApi {
  const reply = api?.runtime?.channel?.reply;
  if (!reply) throw new Error('OpenClaw channel reply API is unavailable');
  return reply;
}

export function resolveOpenClawEnvelopeFormatOptions(api: RuntimeApiHolder, cfg: unknown): unknown {
  const reply = resolveReplyApi(api);
  if (typeof reply.resolveEnvelopeFormatOptions !== 'function') {
    throw new Error('OpenClaw channel reply resolveEnvelopeFormatOptions API is unavailable');
  }
  return reply.resolveEnvelopeFormatOptions(cfg);
}

export function formatOpenClawAgentEnvelope(
  api: RuntimeApiHolder,
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
  if (typeof reply.formatAgentEnvelope !== 'function') {
    throw new Error('OpenClaw channel reply formatAgentEnvelope API is unavailable');
  }
  return reply.formatAgentEnvelope(params);
}

export async function dispatchOpenClawReplyWithBufferedBlockDispatcher(
  api: RuntimeApiHolder,
  params: {
    ctx: unknown;
    cfg: unknown;
    dispatcherOptions: {
      deliver: (
        payload: {
          text?: string;
          mediaUrl?: string;
          mediaUrls?: string[];
          audioAsVoice?: boolean;
        },
        info?: { kind?: 'tool' | 'block' | 'final' },
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
  if (typeof reply.dispatchReplyWithBufferedBlockDispatcher !== 'function') {
    throw new Error(
      'OpenClaw channel reply dispatchReplyWithBufferedBlockDispatcher API is unavailable',
    );
  }
  return reply.dispatchReplyWithBufferedBlockDispatcher(params);
}
