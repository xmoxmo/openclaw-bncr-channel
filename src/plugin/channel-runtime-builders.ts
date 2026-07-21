// Aggregated runtime wiring entrypoint.
//
// Only builders actively called from channel.ts are kept here.
// Dead builder projections have been removed.

export {
  buildBncrChannelSendRuntime,
  buildBncrInboundSurfaceRuntime,
} from './channel-runtime-builders-delivery.ts';

export { buildBncrBridgeSurfaceHandlersRuntime } from './channel-runtime-builders-status.ts';
