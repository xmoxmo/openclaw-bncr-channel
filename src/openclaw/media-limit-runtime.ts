import { resolveChannelMediaMaxBytes } from 'openclaw/plugin-sdk/media-runtime';
import { DEFAULT_BNCR_MEDIA_MAX_MB } from '../core/config-schema.ts';
import type { BncrChannelConfigRoot } from '../plugin/channel-runtime-types.ts';
import { getOpenClawRuntimeConfigOrDefault } from './config-runtime.ts';

const MEBIBYTE = 1024 * 1024;

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

// The host normalizes account ids to lowercase before handing them to resolveChannelLimitMb,
// while Bncr keeps its configured account keys verbatim (e.g. "Primary"). Matching must ignore
// case so an account-level mediaMaxMb still wins over the channel-level value.
function readAccountMediaMaxMb(
  accounts: Record<string, unknown> | undefined,
  normalizedAccountId: string | undefined,
): number | undefined {
  if (!accounts || typeof accounts !== 'object' || !normalizedAccountId) return undefined;
  const direct = positiveNumber((accounts as Record<string, unknown>)[normalizedAccountId]);
  if (direct !== undefined) return direct;
  const wanted = normalizedAccountId.toLowerCase();
  for (const [key, value] of Object.entries(accounts)) {
    if (key.toLowerCase() !== wanted) continue;
    const scoped = positiveNumber(
      value && typeof value === 'object'
        ? (value as { mediaMaxMb?: unknown }).mediaMaxMb
        : undefined,
    );
    if (scoped !== undefined) return scoped;
  }
  return undefined;
}

export function fallbackBncrMediaMaxBytes(): number {
  return DEFAULT_BNCR_MEDIA_MAX_MB * MEBIBYTE;
}

export function resolveBncrMediaMaxBytes(
  api: Parameters<typeof getOpenClawRuntimeConfigOrDefault>[0],
  accountId?: string | null,
): number {
  const cfg = getOpenClawRuntimeConfigOrDefault<BncrChannelConfigRoot | null | undefined>(
    api,
    null,
  );
  const channelCfg = cfg && typeof cfg === 'object' ? cfg.channels?.bncr : undefined;
  const resolved = resolveChannelMediaMaxBytes({
    cfg: (cfg && typeof cfg === 'object' ? cfg : { channels: {} }) as Parameters<
      typeof resolveChannelMediaMaxBytes
    >[0]['cfg'],
    accountId,
    resolveChannelLimitMb: ({ accountId: normalizedAccountId }) => {
      return (
        readAccountMediaMaxMb(channelCfg?.accounts, normalizedAccountId) ??
        positiveNumber(channelCfg?.mediaMaxMb)
      );
    },
  });
  return positiveNumber(resolved) ?? fallbackBncrMediaMaxBytes();
}
