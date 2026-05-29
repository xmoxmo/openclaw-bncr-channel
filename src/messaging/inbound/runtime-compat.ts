import { emitBncrLogLine } from '../../core/logging.ts';

type ChannelRuntimeCompat = {
  buildContext: (...args: any[]) => any;
  run: (...args: any[]) => Promise<any> | any;
  runPreparedReply?: (...args: any[]) => Promise<any> | any;
  dispatchReply?: (...args: any[]) => Promise<any> | any;
};

let warnedLegacyTurnRuntime = false;

export function resolveBncrChannelInboundRuntime(api: any): ChannelRuntimeCompat {
  const channelRuntime = api?.runtime?.channel;
  const inboundRuntime = channelRuntime?.inbound;
  if (inboundRuntime?.buildContext && inboundRuntime?.run) {
    return inboundRuntime;
  }

  const legacyTurnRuntime = channelRuntime?.turn;
  if (legacyTurnRuntime?.buildContext && legacyTurnRuntime?.run) {
    if (!warnedLegacyTurnRuntime) {
      warnedLegacyTurnRuntime = true;
      emitBncrLogLine(
        'warn',
        '[bncr] using legacy runtime.channel.turn compatibility path; upgrade path prefers runtime.channel.inbound',
      );
    }
    return {
      buildContext: legacyTurnRuntime.buildContext,
      run: legacyTurnRuntime.run,
      runPreparedReply: legacyTurnRuntime.runPrepared,
      dispatchReply: legacyTurnRuntime.dispatchAssembled ?? legacyTurnRuntime.runAssembled,
    };
  }

  throw new Error(
    'OpenClaw channel inbound runtime is unavailable: expected runtime.channel.inbound.* or legacy runtime.channel.turn.*',
  );
}
