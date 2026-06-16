import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OUTBOUND_DEGRADE_REASON,
  OUTBOUND_FLUSH_REASON,
  OUTBOUND_FLUSH_TRIGGER,
  OUTBOUND_SCHEDULE_SOURCE,
  OUTBOUND_TERMINAL_REASON,
} from '../../src/messaging/outbound/reasons.ts';

test('outbound reasons exposes stable degrade reason values', () => {
  assert.deepEqual(OUTBOUND_DEGRADE_REASON, {
    ACK_TIMEOUT: 'ack-timeout',
    PUSH_UNCONFIRMED: 'push-unconfirmed',
  });
});

test('outbound reasons exposes stable terminal reason values', () => {
  assert.deepEqual(OUTBOUND_TERMINAL_REASON, {
    PUSH_ACK_TIMEOUT: 'push-ack-timeout',
    PUSH_DELIVERY_UNCONFIRMED: 'push-delivery-unconfirmed',
    PUSH_RETRY_LIMIT: 'push-retry-limit',
    PUSH_RETRY: 'push-retry',
    FILE_ACK_TIMEOUT: 'file-ack-timeout',
  });
});

test('outbound reasons exposes stable flush trigger and reason values', () => {
  assert.deepEqual(OUTBOUND_FLUSH_TRIGGER, {
    TIMER: 'timer',
    CONNECT: 'connect',
    ACK_OK: 'ack-ok',
    ACTIVITY: 'activity',
    INBOUND: 'inbound',
  });
  assert.deepEqual(OUTBOUND_FLUSH_REASON, {
    SCHEDULED_DRAIN: 'scheduled-drain',
    WS_ONLINE: 'ws-online',
    MESSAGE_ACKED: 'message-acked',
    ACTIVITY_HEARTBEAT: 'activity-heartbeat',
    INBOUND_ACCEPTED: 'inbound-accepted',
  });
});

test('outbound reasons exposes stable scheduling source values', () => {
  assert.deepEqual(OUTBOUND_SCHEDULE_SOURCE, {
    SCHEDULE_PUSH_DRAIN: 'schedule-push-drain',
    ACCOUNT_NO_DUE_ENTRY: 'account-no-due-entry',
    RETRY_REROUTE_WAIT: 'retry-reroute-wait',
    PUSH_FAIL_WAIT: 'push-fail-wait',
    PRE_PUSH_GUARD_WAIT: 'pre-push-guard-wait',
    ACCOUNT_BUDGET_YIELD: 'account-budget-yield',
    ACCOUNT_TIME_BUDGET_YIELD: 'account-time-budget-yield',
    ACCOUNT_NEXT_DELAY_MERGE: 'account-next-delay-merge',
    FLUSH_NEXT_DRAIN: 'flush-next-drain',
  });
});
