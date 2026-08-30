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
