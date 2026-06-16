// Aggregated bridge runtime helper entrypoint.
//
// The helpers are grouped by concern so snapshot shaping, delivery-facing
// runtime adapters, and support runtime ownership stay readable without
// changing import sites.

export {
  buildBridgeDrainTriggers,
  buildBridgeLifecycleMarkers,
  buildBridgeRuntimeStatusInput,
  buildBridgeStatusProjectionRuntime,
  buildChannelSendTargetRuntime,
  buildFlushBestEffortError,
  buildFlushOnActivityArgs,
  buildFlushOnConnectArgs,
  buildInboundSurfaceActivityRuntime,
  buildInboundSurfaceConnectionRuntime,
} from './bridge-runtime-helpers.ts';

export {
  buildConnectionRuntimeSnapshot,
  buildOutboundRuntimeSnapshot,
  buildRegisterRuntimeSnapshot,
  buildStatusWorkerActiveConnections,
  buildStatusWorkerLastEventAt,
} from './bridge-runtime-snapshots.ts';

export { createBridgeSupportRuntime } from './bridge-support-runtime.ts';
