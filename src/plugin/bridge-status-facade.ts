import type {
  BncrAccountRuntimeSnapshot,
  buildIntegratedDiagnostics as buildIntegratedDiagnosticsFromRuntime,
} from '../core/status.ts';
import type { BncrAckObservability } from '../core/types.ts';

type RuntimeStatusInput = Parameters<typeof buildIntegratedDiagnosticsFromRuntime>[0];
type RuntimeStatusMeta = BncrAccountRuntimeSnapshot['meta'];

export function buildBncrStatusProjectionRuntime(runtime: {
  buildRuntimeStatusInput: (
    accountId: string,
    overrides?: Partial<RuntimeStatusInput>,
  ) => RuntimeStatusInput;
  buildStatusMeta: (accountId: string) => RuntimeStatusMeta;
  getAccountRuntimeSnapshot: (
    accountId: string,
    runtimeStatusInput: RuntimeStatusInput,
  ) => BncrAccountRuntimeSnapshot;
  buildStatusHeadline: (accountId: string) => string;
  getStatusHeadline: (accountId: string) => string;
  getChannelSummary: (defaultAccountId: string) => Record<string, unknown>;
}) {
  return { ...runtime };
}

export function buildBncrAckDiagnosticsRuntime(runtime: {
  buildRuntimeAckObservability: (accountId: string) => BncrAckObservability;
  buildRuntimeAckStrategy: (ackObservability: BncrAckObservability) => unknown;
}) {
  return { ...runtime };
}

export function createBncrBridgeStatusFacade(runtime: {
  statusProjection: ReturnType<typeof buildBncrStatusProjectionRuntime>;
  ackDiagnostics: ReturnType<typeof buildBncrAckDiagnosticsRuntime>;
}) {
  const buildRuntimeStatusInput = (
    accountId: string,
    overrides: Partial<RuntimeStatusInput> = {},
  ) => runtime.statusProjection.buildRuntimeStatusInput(accountId, overrides);

  const buildStatusMeta = (accountId: string) =>
    runtime.statusProjection.buildStatusMeta(accountId);

  const getAccountRuntimeSnapshot = (
    accountId: string,
    runtimeStatusInput = buildRuntimeStatusInput(accountId, { running: true }),
  ) => runtime.statusProjection.getAccountRuntimeSnapshot(accountId, runtimeStatusInput);

  const buildStatusHeadline = (accountId: string) =>
    runtime.statusProjection.buildStatusHeadline(accountId);

  const getStatusHeadline = (accountId: string) =>
    runtime.statusProjection.getStatusHeadline(accountId);

  const getChannelSummary = (defaultAccountId: string) =>
    runtime.statusProjection.getChannelSummary(defaultAccountId);

  const buildRuntimeAckObservability = (accountId: string) =>
    runtime.ackDiagnostics.buildRuntimeAckObservability(accountId);

  const buildRuntimeAckStrategy = (ackObservability: BncrAckObservability) =>
    runtime.ackDiagnostics.buildRuntimeAckStrategy(ackObservability);

  return {
    buildRuntimeStatusInput,
    buildStatusMeta,
    getAccountRuntimeSnapshot,
    buildStatusHeadline,
    getStatusHeadline,
    getChannelSummary,
    buildRuntimeAckObservability,
    buildRuntimeAckStrategy,
  };
}
