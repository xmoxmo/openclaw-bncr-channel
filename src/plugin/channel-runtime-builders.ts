// Aggregated runtime wiring entrypoint.
//
// Delivery and status/diagnostics slices now live in dedicated files so the
// bridge wiring catalog stays readable without changing import sites.

export {
  buildBncrAckOutboxRuntime,
  buildBncrChannelSendRuntime,
  buildBncrConnectionStateRuntime,
  buildBncrFileTransferRuntime,
  buildBncrInboundSurfaceRuntime,
  buildBncrMediaOrchestratorsRuntime,
  buildBncrOutboxPushRouteRuntime,
  buildBncrStateTransientRuntime,
} from './channel-runtime-builders-delivery.ts';

export {
  buildBncrBridgeSurfaceHandlersRuntime,
  buildBncrDeadLetterDiagnosticsRuntime,
  buildBncrDiagnosticsSelectionRuntime,
  buildBncrExtendedDiagnosticsAssemblerRuntime,
  buildBncrOutboxDiagnosticsRuntime,
  buildBncrRuntimeAckObservabilityRuntime,
  buildBncrTargetStatusRuntime,
} from './channel-runtime-builders-status.ts';
