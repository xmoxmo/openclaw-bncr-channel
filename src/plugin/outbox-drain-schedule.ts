import { buildOutboxScheduleDebugInfo } from '../messaging/outbound/diagnostics.ts';
import type { OutboundScheduleSource } from '../messaging/outbound/reasons.ts';

function asScheduleSource(source: string): OutboundScheduleSource {
  return source as OutboundScheduleSource;
}

export type BncrOutboxDrainScheduleRuntime = {
  bridgeId: string;
  logInfo: (scope: string, message: string, options?: { debugOnly?: boolean }) => void;
};

export function createBncrOutboxDrainSchedule(runtime: BncrOutboxDrainScheduleRuntime) {
  const logSchedule = (args: {
    accountId?: string;
    messageId?: string;
    source: string;
    wait?: number | null;
    localNextDelay?: number | null;
    globalNextDelay?: number | null;
  }) => {
    runtime.logInfo(
      'outbox',
      `schedule ${JSON.stringify(
        buildOutboxScheduleDebugInfo({
          bridgeId: runtime.bridgeId,
          accountId: args.accountId,
          messageId: args.messageId,
          source: asScheduleSource(args.source),
          wait: args.wait,
          localNextDelay: args.localNextDelay,
          globalNextDelay: args.globalNextDelay,
        }),
      )}`,
      { debugOnly: true },
    );
  };

  const updateDelay = (
    current: number | null,
    wait: number | null,
    updateMinOutboxDelay: (current: number | null, next: number | null) => number | null,
  ) => updateMinOutboxDelay(current, wait);

  const scheduleAccountYield = (args: {
    accountId: string;
    source: string;
    localNextDelay: number | null;
    updateMinOutboxDelay: (current: number | null, next: number | null) => number | null;
  }) => {
    const localNextDelay = updateDelay(args.localNextDelay, 0, args.updateMinOutboxDelay);
    logSchedule({
      accountId: args.accountId,
      source: args.source,
      wait: 0,
      localNextDelay,
    });
    return localNextDelay;
  };

  const scheduleAccountWait = (args: {
    accountId: string;
    messageId?: string;
    source: string;
    wait: number;
    localNextDelay: number | null;
    updateMinOutboxDelay: (current: number | null, next: number | null) => number | null;
  }) => {
    const localNextDelay = updateDelay(args.localNextDelay, args.wait, args.updateMinOutboxDelay);
    logSchedule({
      accountId: args.accountId,
      messageId: args.messageId,
      source: args.source,
      wait: args.wait,
      localNextDelay,
    });
    return localNextDelay;
  };

  const mergeAccountNextDelay = (args: {
    accountId: string;
    localNextDelay: number;
    globalNextDelay: number | null;
    updateMinOutboxDelay: (current: number | null, next: number | null) => number | null;
    source: string;
  }) => {
    const globalNextDelay = updateDelay(
      args.globalNextDelay,
      args.localNextDelay,
      args.updateMinOutboxDelay,
    );
    logSchedule({
      accountId: args.accountId,
      source: args.source,
      localNextDelay: args.localNextDelay,
      globalNextDelay,
    });
    return globalNextDelay;
  };

  const scheduleFlushNextDrain = (args: { globalNextDelay: number; source: string }) => {
    logSchedule({
      source: args.source,
      globalNextDelay: args.globalNextDelay,
      wait: args.globalNextDelay,
    });
  };

  return {
    logSchedule,
    scheduleAccountYield,
    scheduleAccountWait,
    mergeAccountNextDelay,
    scheduleFlushNextDrain,
  };
}
