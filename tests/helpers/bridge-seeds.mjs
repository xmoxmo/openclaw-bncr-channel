import { makeEntry, TEST_ACCOUNT_ID } from './bncr-bridge.mjs';

export function seedConnection(bridge, patch = {}) {
  const now = Date.now();
  const clientId = patch.clientId || 'client-a';
  const key = `${patch.accountId || TEST_ACCOUNT_ID}:${clientId}`;
  const value = {
    accountId: patch.accountId || TEST_ACCOUNT_ID,
    connId: patch.connId || 'conn-a',
    clientId,
    connectedAt: patch.connectedAt ?? now - 10_000,
    lastSeenAt: patch.lastSeenAt ?? now - 1_000,
    outboundReadyUntil: patch.outboundReadyUntil ?? 0,
    preferredForOutboundUntil: patch.preferredForOutboundUntil ?? 0,
    inboundOnly: patch.inboundOnly ?? false,
    ...patch,
  };
  bridge.connections.set(key, value);
  return value;
}

export function seedLiveOutboundConnection(bridge, patch = {}) {
  const now = Date.now();
  return seedConnection(bridge, {
    outboundReadyUntil: now + 60_000,
    preferredForOutboundUntil: now + 60_000,
    inboundOnly: false,
    ...patch,
  });
}

export function seedInboundOnlyConnection(bridge, patch = {}) {
  const now = Date.now();
  return seedConnection(bridge, {
    outboundReadyUntil: 0,
    preferredForOutboundUntil: 0,
    inboundOnly: true,
    lastSeenAt: patch.lastSeenAt ?? now - 1_000,
    ...patch,
  });
}

export function makeEntries(prefix, count, patch) {
  return Array.from({ length: count }, (_, index) =>
    makeEntry(
      `${prefix}-${index}`,
      `${prefix} ${index}`,
      typeof patch === 'function' ? patch(index) : patch,
    ),
  );
}

export function seedPersistedOutboxState(entries) {
  return Object.fromEntries(entries.map((entry) => [entry.messageId, entry]));
}

export function seedPersistedDeadLetterState(entries) {
  return entries.map((entry) => ({ ...entry }));
}
