import type { BncrRoute } from '../../channel.ts';

export type RetryRerouteDecisionInput = {
  nowMs: number;
  maxRetry: number;
  requireAck: boolean;
  currentRetryCount: number;
  currentRouteAttemptRound: number;
  currentFastReroutePending: boolean;
  lastError?: string;
  currentConnId?: string;
  attemptedConnIds: string[];
  availableConnIds: string[];
};

export type RetryRerouteDecision =
  | {
      kind: 'dead-letter';
      terminalReason: string;
      nextRetryCount: number;
      lastAttemptAt: number;
    }
  | {
      kind: 'retry';
      nextRetryCount: number;
      lastAttemptAt: number;
      nextAttemptAt: number;
      lastError: string;
      attemptedConnIds: string[];
      fastReroutePending: boolean;
      routeAttemptRound: number;
      hasUntriedAlternative: boolean;
      shouldFastReroute: boolean;
      revalidatedConnIds: string[];
    };

export function computeRetryRerouteDecision(
  input: RetryRerouteDecisionInput,
  deps: { backoffMs: (retryCount: number) => number },
): RetryRerouteDecision {
  const attemptedConnIds = Array.isArray(input.attemptedConnIds)
    ? input.attemptedConnIds.filter((v): v is string => typeof v === 'string' && !!v)
    : [];
  const currentConnId = `${input.currentConnId || ''}`.trim();
  if (currentConnId && !attemptedConnIds.includes(currentConnId)) attemptedConnIds.push(currentConnId);

  const availableConnIds = Array.isArray(input.availableConnIds)
    ? input.availableConnIds.filter((v): v is string => typeof v === 'string' && !!v)
    : [];
  const revalidatedConnIds = attemptedConnIds.filter((connId) => availableConnIds.includes(connId));
  const hasUntriedAlternative = availableConnIds.some((connId) => !attemptedConnIds.includes(connId));
  const shouldFastReroute = input.requireAck && input.currentFastReroutePending !== true && hasUntriedAlternative;

  const nextRetryCount = Number(input.currentRetryCount || 0) + 1;
  const lastAttemptAt = input.nowMs;
  const terminalReason =
    input.lastError || (input.requireAck ? 'push-ack-timeout' : 'push-delivery-unconfirmed');

  if (nextRetryCount > input.maxRetry) {
    return {
      kind: 'dead-letter',
      terminalReason,
      nextRetryCount,
      lastAttemptAt,
    };
  }

  const nextAttemptAt = shouldFastReroute ? input.nowMs + 1_000 : input.nowMs + deps.backoffMs(nextRetryCount);
  const lastError = input.requireAck ? 'push-ack-timeout' : 'push-delivery-unconfirmed';
  const routeAttemptRound = hasUntriedAlternative ? Number(input.currentRouteAttemptRound || 0) : Number(input.currentRouteAttemptRound || 0) + 1;
  const fastReroutePending = hasUntriedAlternative ? shouldFastReroute || input.currentFastReroutePending === true : false;

  return {
    kind: 'retry',
    nextRetryCount,
    lastAttemptAt,
    nextAttemptAt,
    lastError,
    attemptedConnIds: hasUntriedAlternative ? attemptedConnIds : [],
    fastReroutePending,
    routeAttemptRound,
    hasUntriedAlternative,
    shouldFastReroute,
    revalidatedConnIds,
  };
}

export type PushFailureDecisionInput = {
  nowMs: number;
  maxRetry: number;
  currentRetryCount: number;
  lastError?: string;
};

export type PushFailureDecision =
  | {
      kind: 'dead-letter';
      terminalReason: string;
      nextRetryCount: number;
      lastAttemptAt: number;
    }
  | {
      kind: 'retry';
      nextRetryCount: number;
      lastAttemptAt: number;
      nextAttemptAt: number;
      lastError: string;
    };

export function computePushFailureDecision(
  input: PushFailureDecisionInput,
  deps: { backoffMs: (retryCount: number) => number },
): PushFailureDecision {
  const nextRetryCount = Number(input.currentRetryCount || 0) + 1;
  const lastAttemptAt = input.nowMs;

  if (nextRetryCount > input.maxRetry) {
    return {
      kind: 'dead-letter',
      terminalReason: input.lastError || 'push-retry-limit',
      nextRetryCount,
      lastAttemptAt,
    };
  }

  return {
    kind: 'retry',
    nextRetryCount,
    lastAttemptAt,
    nextAttemptAt: input.nowMs + deps.backoffMs(nextRetryCount),
    lastError: input.lastError || 'push-retry',
  };
}
