export const OUTBOUND_DEGRADE_REASON = {
  ACK_TIMEOUT: 'ack-timeout',
  PUSH_UNCONFIRMED: 'push-unconfirmed',
} as const;

export const OUTBOUND_TERMINAL_REASON = {
  PUSH_ACK_TIMEOUT: 'push-ack-timeout',
  PUSH_DELIVERY_UNCONFIRMED: 'push-delivery-unconfirmed',
  PUSH_RETRY_LIMIT: 'push-retry-limit',
  PUSH_RETRY: 'push-retry',
  FILE_ACK_TIMEOUT: 'file-ack-timeout',
} as const;

export const OUTBOUND_FLUSH_REASON = {
  SCHEDULED_DRAIN: 'scheduled-drain',
  WS_ONLINE: 'ws-online',
  MESSAGE_ACKED: 'message-acked',
  ACTIVITY_HEARTBEAT: 'activity-heartbeat',
  INBOUND_ACCEPTED: 'inbound-accepted',
} as const;

export const OUTBOUND_FLUSH_TRIGGER = {
  TIMER: 'timer',
  CONNECT: 'connect',
  ACK_OK: 'ack-ok',
  ACTIVITY: 'activity',
  INBOUND: 'inbound',
} as const;

// Scheduling debug sources describe where a next-drain wait came from.
// They are observability taxonomy only; do not derive runtime behavior from them.
export const OUTBOUND_SCHEDULE_SOURCE = {
  // Single pending timer was armed by schedulePushDrain(...).
  SCHEDULE_PUSH_DRAIN: 'schedule-push-drain',
  // Current account has queued work, but nothing is due yet.
  ACCOUNT_NO_DUE_ENTRY: 'account-no-due-entry',
  // Ack-timeout / reroute path kept entry in outbox and scheduled a retry.
  RETRY_REROUTE_WAIT: 'retry-reroute-wait',
  // Direct push failure kept entry in outbox and scheduled backoff.
  PUSH_FAIL_WAIT: 'push-fail-wait',
  // Pre-push guard deferred delivery before an actual send attempt.
  PRE_PUSH_GUARD_WAIT: 'pre-push-guard-wait',
  // Per-account flush processed its single-run item budget and yielded to the next drain.
  ACCOUNT_BUDGET_YIELD: 'account-budget-yield',
  // Per-account flush spent its single-run time budget and yielded to the next drain.
  ACCOUNT_TIME_BUDGET_YIELD: 'account-time-budget-yield',
  // Account-local next delay was merged into bridge-global next delay.
  ACCOUNT_NEXT_DELAY_MERGE: 'account-next-delay-merge',
  // flushPushQueue(...) finished and armed the next bridge-level drain.
  FLUSH_NEXT_DRAIN: 'flush-next-drain',
} as const;

export type OutboundScheduleSource =
  (typeof OUTBOUND_SCHEDULE_SOURCE)[keyof typeof OUTBOUND_SCHEDULE_SOURCE];
