import type { OutboxEntry } from '../core/types.ts';
import { buildOutboxQueueDiagnostics } from '../messaging/outbound/diagnostics.ts';
import { createBncrOutboxDiagnosticsHelpers as createBncrOutboxDiagnosticsHelpersBase } from './runtime-diagnostics-helpers.ts';
import { buildBncrOutboxQueueDiagnosticsInput } from './runtime-diagnostics-payload-builders.ts';

export {
  buildBncrExtendedDiagnosticsSnapshot,
  createBncrExtendedDiagnosticsAssembler,
} from './runtime-diagnostics-assembler.ts';

export {
  buildBncrDeadLetterDiagnosticsSnapshot,
  createBncrDeadLetterDiagnosticsHelpers,
  createBncrDiagnosticsSelectionHelpers,
  createBncrRuntimeAckObservabilityBuilder,
  type ExtendedDiagnosticsAssemblerOptions,
  type ExtendedDiagnosticsAssemblerRuntime,
} from './runtime-diagnostics-helpers.ts';

export function createBncrOutboxDiagnosticsHelpers(runtime: {
  normalizeAccountId: (accountId: string) => string;
  outboxValues: () => Iterable<OutboxEntry>;
  pendingAllAccounts: () => number;
  resolvePushConnIds: (accountId: string) => Set<string>;
}) {
  return createBncrOutboxDiagnosticsHelpersBase({
    ...runtime,
    buildOutboxQueueDiagnostics,
    buildBncrOutboxQueueDiagnosticsInput,
  });
}
