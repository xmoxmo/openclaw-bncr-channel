export function createBncrBridgeDiagnosticsFacade<
  TRuntimeFlags,
  TQueueCounters,
  TIntegratedDiagnostics,
  TDownlinkHealth,
  TRuntimeStatusInput = unknown,
>(runtime: {
  buildRuntimeFlags: (accountId?: string) => TRuntimeFlags;
  buildAccountQueueCounters: (accountId: string) => TQueueCounters;
  buildIntegratedDiagnostics: (
    accountId: string,
    runtimeStatusInput?: TRuntimeStatusInput,
  ) => TIntegratedDiagnostics;
  buildDownlinkHealth: (accountId: string) => TDownlinkHealth;
}) {
  return {
    buildRuntimeFlags: (accountId?: string) => runtime.buildRuntimeFlags(accountId),
    buildAccountQueueCounters: (accountId: string) => runtime.buildAccountQueueCounters(accountId),
    buildIntegratedDiagnostics: (accountId: string, runtimeStatusInput?: TRuntimeStatusInput) =>
      runtime.buildIntegratedDiagnostics(accountId, runtimeStatusInput),
    buildDownlinkHealth: (accountId: string) => runtime.buildDownlinkHealth(accountId),
  };
}
