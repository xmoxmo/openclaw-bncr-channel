import { emitBncrLogLine } from '../core/logging.ts';
import type { BncrChannelConfigRoot } from '../plugin/channel-runtime-types.ts';

let warnedConfigFallback = false;

type RuntimeConfigApi = {
  current?: () => BncrChannelConfigRoot;
  get?: () => BncrChannelConfigRoot;
  mutateConfigFile?: (params: {
    afterWrite?: { mode?: string };
    mutate: (draft: Record<string, unknown>) => void;
  }) => Promise<unknown> | unknown;
};

type RuntimeApiHolder = {
  runtime?: {
    config?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function resolveConfigApi(api: RuntimeApiHolder): RuntimeConfigApi {
  const config = api?.runtime?.config;
  if (!config || typeof config !== 'object') {
    throw new Error('OpenClaw runtime config API is unavailable');
  }
  return config as RuntimeConfigApi;
}

export function getOpenClawRuntimeConfig(api: RuntimeApiHolder): BncrChannelConfigRoot {
  const config = resolveConfigApi(api);
  if (typeof config.current === 'function') return config.current();
  if (typeof config.get === 'function') return config.get();
  throw new Error('OpenClaw runtime config read API is unavailable');
}

export function getOpenClawRuntimeConfigOrDefault<T>(
  api: RuntimeApiHolder,
  fallback: T,
): BncrChannelConfigRoot | T {
  try {
    return getOpenClawRuntimeConfig(api);
  } catch (error) {
    // Falling back silently would look like "the setting did not apply", so say
    // it once: everything below this point uses built-in defaults.
    if (!warnedConfigFallback) {
      warnedConfigFallback = true;
      emitBncrLogLine(
        'warn',
        `[bncr] runtime config unavailable; using built-in defaults|err=${String(error)}`,
      );
    }
    return fallback;
  }
}

export async function mutateOpenClawRuntimeConfigFile(
  api: RuntimeApiHolder,
  params: {
    afterWrite?: { mode?: string };
    mutate: (draft: Record<string, unknown>) => void;
  },
): Promise<unknown> {
  const config = resolveConfigApi(api);
  if (typeof config.mutateConfigFile !== 'function') {
    throw new Error('OpenClaw runtime config mutate API is unavailable');
  }
  return config.mutateConfigFile(params);
}
