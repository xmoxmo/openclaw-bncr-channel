import { emitBncrLogLine } from '../../core/logging.ts';
import type { OpenClawInboundRuntime } from '../../openclaw/channel-runtime-contracts.ts';
import type { BncrInboundApi } from './contracts.ts';

type InboundRuntimeShape = {
  buildContext?: (params: unknown) => unknown;
  run?: (params: unknown) => unknown;
  runPreparedReply?: (params: unknown) => unknown;
  dispatchReply?: (params: unknown) => unknown;
};

type LegacyTurnRuntimeShape = {
  buildContext?: (params: unknown) => unknown;
  run?: (params: unknown) => unknown;
  runPrepared?: (params: unknown) => unknown;
  dispatchAssembled?: (params: unknown) => unknown;
  runAssembled?: (params: unknown) => unknown;
};

type ChannelRuntimeShape = {
  inbound?: InboundRuntimeShape;
  turn?: LegacyTurnRuntimeShape;
  [key: string]: unknown;
};

let warnedLegacyTurnRuntime = false;

export function resolveBncrChannelInboundRuntime(api: BncrInboundApi): OpenClawInboundRuntime {
  const channelRuntime = api?.runtime?.channel as ChannelRuntimeShape | undefined;
  const inboundRuntime = channelRuntime?.inbound;
  if (inboundRuntime?.buildContext && inboundRuntime?.run) {
    return {
      buildContext: inboundRuntime.buildContext as OpenClawInboundRuntime['buildContext'],
      run: inboundRuntime.run as OpenClawInboundRuntime['run'],
      runPreparedReply: inboundRuntime.runPreparedReply,
      dispatchReply: inboundRuntime.dispatchReply,
    };
  }

  const legacyTurnRuntime = channelRuntime?.turn;
  if (legacyTurnRuntime?.buildContext && legacyTurnRuntime?.run) {
    if (!warnedLegacyTurnRuntime) {
      warnedLegacyTurnRuntime = true;
      const channelRuntimeKeys =
        Object.keys(channelRuntime ?? {})
          .sort()
          .join(',') || 'none';
      const inboundRuntimeKeys =
        Object.keys(inboundRuntime ?? {})
          .sort()
          .join(',') || 'none';
      emitBncrLogLine(
        'warn',
        `[bncr] inbound runtime fallback=turn|preferred=inbound|channelKeys=${channelRuntimeKeys}|inboundKeys=${inboundRuntimeKeys}`,
      );
    }
    return {
      buildContext: legacyTurnRuntime.buildContext as OpenClawInboundRuntime['buildContext'],
      run: legacyTurnRuntime.run as OpenClawInboundRuntime['run'],
      runPreparedReply: legacyTurnRuntime.runPrepared,
      dispatchReply: legacyTurnRuntime.dispatchAssembled ?? legacyTurnRuntime.runAssembled,
    };
  }

  throw new Error(
    'OpenClaw channel inbound runtime is unavailable: expected runtime.channel.inbound.* or legacy runtime.channel.turn.*',
  );
}
