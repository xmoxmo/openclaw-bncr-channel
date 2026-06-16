type RuntimeSurfaceContractKind = 'object' | 'function' | 'functionAnyOf';

type RuntimeSurfaceContract = {
  key: string;
  kind: RuntimeSurfaceContractKind;
  path?: readonly string[];
  anyOf?: readonly (readonly string[])[];
  parent?: readonly string[];
};

export const OPENCLAW_RUNTIME_SURFACE_CONTRACTS = [
  { key: 'runtime.config', kind: 'object', path: ['runtime', 'config'] },
  {
    key: 'runtime.config.current|get',
    kind: 'functionAnyOf',
    anyOf: [
      ['runtime', 'config', 'current'],
      ['runtime', 'config', 'get'],
    ],
    parent: ['runtime', 'config'],
  },
  {
    key: 'runtime.config.mutateConfigFile',
    kind: 'function',
    path: ['runtime', 'config', 'mutateConfigFile'],
    parent: ['runtime', 'config'],
  },
  { key: 'runtime.media', kind: 'object', path: ['runtime', 'media'] },
  {
    key: 'runtime.media.loadWebMedia',
    kind: 'function',
    path: ['runtime', 'media', 'loadWebMedia'],
    parent: ['runtime', 'media'],
  },
  { key: 'runtime.channel.inbound', kind: 'object', path: ['runtime', 'channel', 'inbound'] },
  {
    key: 'runtime.channel.inbound.buildContext',
    kind: 'function',
    path: ['runtime', 'channel', 'inbound', 'buildContext'],
    parent: ['runtime', 'channel', 'inbound'],
  },
  {
    key: 'runtime.channel.inbound.run',
    kind: 'function',
    path: ['runtime', 'channel', 'inbound', 'run'],
    parent: ['runtime', 'channel', 'inbound'],
  },
  { key: 'runtime.channel.media', kind: 'object', path: ['runtime', 'channel', 'media'] },
  {
    key: 'runtime.channel.media.readRemoteMediaBuffer',
    kind: 'function',
    path: ['runtime', 'channel', 'media', 'readRemoteMediaBuffer'],
    parent: ['runtime', 'channel', 'media'],
  },
  {
    key: 'runtime.channel.media.saveMediaBuffer',
    kind: 'function',
    path: ['runtime', 'channel', 'media', 'saveMediaBuffer'],
    parent: ['runtime', 'channel', 'media'],
  },
  { key: 'runtime.channel.reply', kind: 'object', path: ['runtime', 'channel', 'reply'] },
  {
    key: 'runtime.channel.reply.resolveEnvelopeFormatOptions',
    kind: 'function',
    path: ['runtime', 'channel', 'reply', 'resolveEnvelopeFormatOptions'],
    parent: ['runtime', 'channel', 'reply'],
  },
  {
    key: 'runtime.channel.reply.formatAgentEnvelope',
    kind: 'function',
    path: ['runtime', 'channel', 'reply', 'formatAgentEnvelope'],
    parent: ['runtime', 'channel', 'reply'],
  },
  {
    key: 'runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher',
    kind: 'function',
    path: ['runtime', 'channel', 'reply', 'dispatchReplyWithBufferedBlockDispatcher'],
    parent: ['runtime', 'channel', 'reply'],
  },
  { key: 'runtime.channel.routing', kind: 'object', path: ['runtime', 'channel', 'routing'] },
  {
    key: 'runtime.channel.routing.resolveAgentRoute',
    kind: 'function',
    path: ['runtime', 'channel', 'routing', 'resolveAgentRoute'],
    parent: ['runtime', 'channel', 'routing'],
  },
  { key: 'runtime.channel.session', kind: 'object', path: ['runtime', 'channel', 'session'] },
  {
    key: 'runtime.channel.session.readSessionUpdatedAt',
    kind: 'function',
    path: ['runtime', 'channel', 'session', 'readSessionUpdatedAt'],
    parent: ['runtime', 'channel', 'session'],
  },
] as const satisfies readonly RuntimeSurfaceContract[];

export type OpenClawChannelRuntimeSurfaceDiagnostics = {
  runtime: {
    config: boolean;
    media: boolean;
  };
  channel: {
    inbound: boolean;
    media: boolean;
    reply: boolean;
    routing: boolean;
    session: boolean;
  };
  channelMedia: {
    readRemoteMediaBuffer: boolean;
    saveMediaBuffer: boolean;
  };
  contract: Record<string, boolean>;
  missing: string[];
};

function getPathValue(root: unknown, path: readonly string[] | undefined): unknown {
  let current: unknown = root;
  for (const key of path ?? []) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function hasObject(root: unknown, path: readonly string[] | undefined): boolean {
  const value = getPathValue(root, path);
  return Boolean(value && typeof value === 'object');
}

function hasFunction(root: unknown, path: readonly string[] | undefined): boolean {
  return typeof getPathValue(root, path) === 'function';
}

function evaluateRuntimeSurfaceContract(root: unknown, spec: RuntimeSurfaceContract): boolean {
  if (spec.parent && !hasObject(root, spec.parent)) return false;
  if (spec.kind === 'object') return hasObject(root, spec.path);
  if (spec.kind === 'function') return hasFunction(root, spec.path);
  return Boolean(spec.anyOf?.some((path) => hasFunction(root, path)));
}

export function buildOpenClawChannelRuntimeSurfaceDiagnostics(
  api: unknown,
): OpenClawChannelRuntimeSurfaceDiagnostics {
  const contract = Object.fromEntries(
    OPENCLAW_RUNTIME_SURFACE_CONTRACTS.map((spec) => [
      spec.key,
      evaluateRuntimeSurfaceContract(api, spec),
    ]),
  ) as Record<string, boolean>;
  const missing = OPENCLAW_RUNTIME_SURFACE_CONTRACTS.filter((spec) => !contract[spec.key]).map(
    (spec) => spec.key,
  );

  return {
    runtime: {
      config: contract['runtime.config'],
      media: contract['runtime.media'],
    },
    channel: {
      inbound: contract['runtime.channel.inbound'],
      media: contract['runtime.channel.media'],
      reply: contract['runtime.channel.reply'],
      routing: contract['runtime.channel.routing'],
      session: contract['runtime.channel.session'],
    },
    channelMedia: {
      readRemoteMediaBuffer: contract['runtime.channel.media.readRemoteMediaBuffer'],
      saveMediaBuffer: contract['runtime.channel.media.saveMediaBuffer'],
    },
    contract,
    missing,
  };
}
