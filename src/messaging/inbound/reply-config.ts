type BncrReplyConfigResult = {
  blockStreaming: boolean;
  allowTool: boolean;
  replyCfg: any;
};

function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['true', 'on', '1', 'yes'].includes(normalized)) return true;
  if (['false', 'off', '0', 'no'].includes(normalized)) return false;
  return undefined;
}

export function resolveBncrBlockStreaming(cfg: any): boolean {
  const channelValue = parseBooleanLike(cfg?.channels?.bncr?.blockStreaming);
  if (channelValue !== undefined) return channelValue;

  const globalValue = parseBooleanLike(cfg?.agents?.defaults?.blockStreamingDefault);
  if (globalValue !== undefined) return globalValue;

  return true;
}

export function resolveBncrAllowTool(cfg: any): boolean {
  return cfg?.channels?.bncr?.allowTool === true;
}

export function buildBncrReplyConfig(cfg: any): BncrReplyConfigResult {
  const blockStreaming = resolveBncrBlockStreaming(cfg);
  const allowTool = resolveBncrAllowTool(cfg);

  const replyCfg = {
    ...cfg,
    agents: {
      ...(cfg?.agents ?? {}),
      defaults: {
        ...(cfg?.agents?.defaults ?? {}),
      },
    },
  };

  if (replyCfg.agents.defaults.blockStreamingBreak == null) {
    replyCfg.agents.defaults.blockStreamingBreak = 'message_end';
  }

  if (replyCfg.agents.defaults.blockStreamingChunk == null) {
    replyCfg.agents.defaults.blockStreamingChunk = {
      minChars: 500,
      maxChars: 4096,
    };
  }

  return { blockStreaming, allowTool, replyCfg };
}
