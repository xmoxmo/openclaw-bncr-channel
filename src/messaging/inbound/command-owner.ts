import type { BncrInboundConfig } from './contracts.ts';

/**
 * Inject a sender into cfg.commands.ownerAllowFrom without mutating cfg.
 * The sender is only added when the caller may be treated as an owner for
 * OpenClaw native command dispatch.
 */
export function mergeBncrOwnerAllowFromIntoConfig(args: {
  cfg: BncrInboundConfig;
  senderIdForContext: string;
}): BncrInboundConfig {
  const { cfg, senderIdForContext } = args;
  const senderId = String(senderIdForContext || '').trim();
  if (!senderId) return cfg;

  const rawCommands = cfg.commands;
  const currentCommands: { ownerAllowFrom?: string[] } =
    rawCommands !== null && typeof rawCommands === 'object' && !Array.isArray(rawCommands)
      ? (rawCommands as { ownerAllowFrom?: string[] })
      : {};
  const currentOwnerAllowFrom = Array.isArray(currentCommands.ownerAllowFrom)
    ? currentCommands.ownerAllowFrom
    : [];
  if (currentOwnerAllowFrom.includes(senderId)) return cfg;

  return {
    ...cfg,
    commands: {
      ...currentCommands,
      ownerAllowFrom: [...currentOwnerAllowFrom, senderId],
    },
  } satisfies BncrInboundConfig;
}

/**
 * Build the one-turn config patch that lets the host's standard resolver recognize
 * a BNCR administrator from the same per-turn owner injection used by command dispatch.
 * The caller owns authorization: only an explicit platform admin identity may pass.
 */
export function resolveBncrHostOwnerConfigOverride(args: {
  cfg: BncrInboundConfig;
  isAdmin: boolean;
  senderId: string;
}): { commands: { ownerAllowFrom: string[] } } | undefined {
  const senderId = String(args.senderId || '').trim();
  if (args.isAdmin !== true || !senderId) return undefined;
  const merged = mergeBncrOwnerAllowFromIntoConfig({
    cfg: args.cfg,
    senderIdForContext: senderId,
  });
  const commands: unknown = merged?.commands;
  const ownerAllowFrom =
    commands !== null && typeof commands === 'object' && !Array.isArray(commands)
      ? (commands as { ownerAllowFrom?: unknown }).ownerAllowFrom
      : undefined;
  if (!Array.isArray(ownerAllowFrom)) return undefined;
  return { commands: { ownerAllowFrom: [...ownerAllowFrom] } };
}
