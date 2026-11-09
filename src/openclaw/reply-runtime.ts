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

type BufferedBlockDispatcherParams = {
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
  dispatchReplyFromConfig?: (request: Record<string, unknown>) => Promise<unknown> | unknown;
};

function isPlainConfigPatch(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergeOwnerPatchIntoHostConfigOverride(args: {
  existingOverride: unknown;
  ownerPatch: Record<string, unknown>;
}): Record<string, unknown> {
  const { existingOverride, ownerPatch } = args;
  const ownerCommands = ownerPatch.commands;
  if (!isPlainConfigPatch(ownerCommands) || !Array.isArray(ownerCommands.ownerAllowFrom)) {
    throw new Error('OpenClaw channel reply owner config patch is malformed');
  }
  const ownerAllowFrom = ownerCommands.ownerAllowFrom as unknown[];
  if (existingOverride === undefined || existingOverride === null) return ownerPatch;
  if (!isPlainConfigPatch(existingOverride)) {
    throw new Error('OpenClaw channel reply configOverride is not a merge patch object');
  }
  const existingCommands = existingOverride.commands;
  if (existingCommands === undefined) {
    return { ...existingOverride, ...ownerPatch };
  }
  if (existingCommands === null || !isPlainConfigPatch(existingCommands)) {
    throw new Error(
      'OpenClaw channel reply configOverride commands conflict with the per-turn owner patch',
    );
  }
  const existingOwners = existingCommands.ownerAllowFrom;
  if (existingOwners !== undefined && existingOwners !== null && !Array.isArray(existingOwners)) {
    throw new Error(
      'OpenClaw channel reply configOverride ownerAllowFrom conflicts with the per-turn owner patch',
    );
  }
  const mergedOwners = Array.isArray(existingOwners)
    ? [...new Set([...existingOwners, ...ownerAllowFrom])]
    : [...ownerAllowFrom];
  return {
    ...existingOverride,
    commands: {
      ...existingCommands,
      ...ownerCommands,
      ownerAllowFrom: mergedOwners,
    },
  };
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
    /** Per-turn RFC 7396 merge patch for the host's published runtime config. */
    hostDispatchConfig?: Record<string, unknown>;
  },
): Promise<unknown> {
  const reply = resolveReplyApi(api);
  const { hostDispatchConfig: hostConfig, ...dispatchParams } = params;
  const typedHostConfig = hostConfig as Record<string, unknown> | undefined;
  const dispatchReplyFromConfig = reply.dispatchReplyFromConfig as
    | ((request: Record<string, unknown>) => Promise<unknown> | unknown)
    | undefined;
  const dispatchReplyWithBufferedBlockDispatcher = reply.dispatchReplyWithBufferedBlockDispatcher as
    | ((params: BufferedBlockDispatcherParams) => Promise<unknown> | unknown)
    | undefined;
  if (hostConfig && typeof dispatchReplyFromConfig !== 'function') {
    throw new Error('OpenClaw channel reply dispatchReplyFromConfig API is unavailable');
  }
  if (typeof dispatchReplyWithBufferedBlockDispatcher !== 'function') {
    throw new Error(
      'OpenClaw channel reply dispatchReplyWithBufferedBlockDispatcher API is unavailable',
    );
  }
  if (!hostConfig) {
    return dispatchReplyWithBufferedBlockDispatcher(dispatchParams);
  }
  const ownerAwareDispatchReplyFromConfig = dispatchReplyFromConfig as (
    request: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
  return dispatchReplyWithBufferedBlockDispatcher({
    ...dispatchParams,
    dispatchReplyFromConfig: (request: Record<string, unknown>) =>
      ownerAwareDispatchReplyFromConfig({
        ...request,
        configOverride: mergeOwnerPatchIntoHostConfigOverride({
          existingOverride: request.configOverride,
          ownerPatch: typedHostConfig as Record<string, unknown>,
        }),
      }),
  } as BufferedBlockDispatcherParams);
}
