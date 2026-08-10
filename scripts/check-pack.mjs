import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const requiredRootFiles = ['index.ts', 'openclaw.plugin.json'];

const requiredScriptFiles = [
  'scripts/check-pack.mjs',
  'scripts/check-register-drift.mjs',
  'scripts/selfcheck.mjs',
];

const requiredSourceFiles = [
  'src/bootstrap/channel-plugin-runtime.ts',
  'src/bootstrap/cli.ts',
  'src/bootstrap/register-runtime-helpers.ts',
  'src/bootstrap/register-runtime.ts',
  'src/bootstrap/runtime-discovery.ts',
  'src/bootstrap/runtime-loader.ts',
  'src/channel.ts',
  'src/core/accounts.ts',
  'src/core/config-schema.ts',
  'src/core/connection-capability.ts',
  'src/core/connection-reachability.ts',
  'src/core/dead-letter-diagnostics.ts',
  'src/core/diagnostic-counters.ts',
  'src/core/diagnostics.ts',
  'src/core/downlink-health.ts',
  'src/core/extended-diagnostics.ts',
  'src/core/file-ack.ts',
  'src/core/file-transfer-payloads.ts',
  'src/core/lease-state.ts',
  'src/core/logging.ts',
  'src/core/outbox-enqueue.ts',
  'src/core/outbox-entry-builders.ts',
  'src/core/outbox-file-transfer-bookkeeping.ts',
  'src/core/outbox-file-transfer-failure.ts',
  'src/core/outbox-file-transfer-guards.ts',
  'src/core/outbox-file-transfer-prep.ts',
  'src/core/outbox-file-transfer-success.ts',
  'src/core/outbox-push-args.ts',
  'src/core/outbox-queue.ts',
  'src/core/outbox-summary.ts',
  'src/core/outbox-text-push-failure.ts',
  'src/core/outbox-text-push-guards.ts',
  'src/core/outbox-text-push-success.ts',
  'src/core/permissions.ts',
  'src/core/persisted-outbox-entry.ts',
  'src/core/policy.ts',
  'src/core/probe.ts',
  'src/core/register-trace.ts',
  'src/core/status-meta.ts',
  'src/core/status.ts',
  'src/core/targets.ts',
  'src/core/types.ts',
  'src/messaging/inbound/commands.ts',
  'src/messaging/inbound/context-facts.ts',
  'src/messaging/inbound/dispatch-prep.ts',
  'src/messaging/inbound/dispatch.ts',
  'src/messaging/inbound/gate.ts',
  'src/messaging/inbound/last-route.ts',
  'src/messaging/inbound/media-url-download.ts',
  'src/messaging/inbound/native-command.ts',
  'src/messaging/inbound/native-reply-delivery.ts',
  'src/messaging/inbound/outbound-replay-cache.ts',
  'src/messaging/inbound/parse.ts',
  'src/messaging/inbound/remote-media.ts',
  'src/messaging/inbound/reply-config.ts',
  'src/messaging/inbound/reply-dispatch.ts',
  'src/messaging/inbound/runtime-compat.ts',
  'src/messaging/inbound/session-label.ts',
  'src/messaging/inbound/turn-context.ts',
  'src/messaging/outbound/actions.ts',
  'src/messaging/outbound/diagnostics.ts',
  'src/messaging/outbound/diagnostics-debug-builders.ts',
  'src/messaging/outbound/durable-queue-adapter.ts',
  'src/messaging/outbound/media-dedupe.ts',
  'src/messaging/outbound/media.ts',
  'src/messaging/outbound/queue-selectors.ts',
  'src/messaging/outbound/reasons.ts',
  'src/messaging/outbound/reply-enqueue.ts',
  'src/messaging/outbound/reply-target-policy.ts',
  'src/messaging/outbound/retry-policy.ts',
  'src/messaging/outbound/session-route.ts',
  'src/messaging/outbound/target-resolver.ts',
  'src/openclaw/config-runtime.ts',
  'src/openclaw/inbound-session-runtime.ts',
  'src/openclaw/media-runtime.ts',
  'src/openclaw/reply-runtime.ts',
  'src/openclaw/routing-runtime.ts',
  'src/openclaw/runtime-surface.ts',
  'src/openclaw/sdk-helpers.ts',
  'src/openclaw/session-route-runtime.ts',
  'src/plugin/ack-outbox-runtime-group.ts',
  'src/plugin/bridge-surface-handlers-group.ts',
  'src/plugin/bridge-surface-helpers.ts',
  'src/plugin/capabilities.ts',
  'src/plugin/channel-components.ts',
  'src/plugin/channel-inbound-helpers.ts',
  'src/plugin/channel-plugin-bridge-group.ts',
  'src/plugin/channel-plugin-surface-group.ts',
  'src/plugin/channel-runtime-constants.ts',
  'src/plugin/channel-runtime-builders.ts',
  'src/plugin/channel-runtime-types.ts',
  'src/plugin/channel-send.ts',
  'src/plugin/channel-utils.ts',
  'src/plugin/bridge-call.ts',
  'src/plugin/client-rpc-runtime.ts',
  'src/plugin/config.ts',
  'src/plugin/connection-handlers.ts',
  'src/plugin/connection-state.ts',
  'src/plugin/connection-state-runtime-group.ts',
  'src/plugin/diagnostics-handlers.ts',
  'src/plugin/file-ack-runtime.ts',
  'src/plugin/file-inbound-abort.ts',
  'src/plugin/file-inbound-chunk.ts',
  'src/plugin/file-inbound-complete.ts',
  'src/plugin/file-inbound-handlers.ts',
  'src/plugin/file-inbound-init.ts',
  'src/plugin/file-inbound-runtime.ts',
  'src/plugin/file-inbound-state.ts',
  'src/plugin/file-transfer-logs.ts',
  'src/plugin/media-dedupe-runtime.ts',
  'src/plugin/file-transfer-orchestrator.ts',
  'src/plugin/media-orchestrators-runtime-group.ts',
  'src/plugin/file-transfer-runtime-group.ts',
  'src/plugin/file-transfer-send.ts',
  'src/plugin/file-transfer-setup.ts',
  'src/plugin/gateway-event-context.ts',
  'src/plugin/gateway-methods.ts',
  'src/plugin/gateway-runtime.ts',
  'src/plugin/inbound-acceptance.ts',
  'src/plugin/inbound-surface-handlers-group.ts',
  'src/plugin/inbound-handlers.ts',
  'src/plugin/message-ack-runtime.ts',
  'src/plugin/message-policy.ts',
  'src/plugin/message-send.ts',
  'src/plugin/messaging.ts',
  'src/plugin/meta.ts',
  'src/plugin/outbound.ts',
  'src/plugin/outbox-ack-logs.ts',
  'src/plugin/outbox-ack-outcome.ts',
  'src/plugin/outbox-drain-ack.ts',
  'src/plugin/outbox-drain-failure.ts',
  'src/plugin/outbox-drain-loop.ts',
  'src/plugin/outbox-drain-post-push.ts',
  'src/plugin/outbox-drain-runtime.ts',
  'src/plugin/outbox-drain-schedule.ts',
  'src/plugin/outbox-push-route-runtime-group.ts',
  'src/plugin/outbox-push.ts',
  'src/plugin/outbox-route.ts',
  'src/plugin/runtime-diagnostics-snapshot.ts',
  'src/plugin/setup.ts',
  'src/plugin/state-transient-runtime-group.ts',
  'src/plugin/state-store.ts',
  'src/plugin/target-runtime.ts',
  'src/plugin/target-status-runtime-group.ts',
  'src/plugin/transient-state-runtime.ts',
  'src/plugin/status-runtime.ts',
  'src/plugin/status.ts',
  'src/runtime/log-dedupe.ts',
  'src/runtime/outbound-ack-timeout.ts',
  'src/runtime/outbound-flags.ts',
  'src/runtime/outbox-transitions.ts',
  'src/runtime/register-trace-runtime.ts',
  'src/runtime/status-snapshots.ts',
  'src/runtime/status-worker.ts',
  'src/bootstrap/register-runtime-gateway.ts',
  'src/bootstrap/register-runtime-singleton.ts',
  'src/core/value-sanitize.ts',
  'src/messaging/inbound/contracts.ts',
  'src/messaging/inbound/conversation-history.ts',
  'src/messaging/inbound/native-command-runtime.ts',
  'src/messaging/inbound/reply-dispatch-serial.ts',
  'src/messaging/inbound/scene-admin.ts',
  'src/messaging/inbound/session-meta-task.ts',
  'src/messaging/outbound/marker-parser.ts',
  'src/messaging/outbound/normalize-outbound-send.ts',
  'src/messaging/outbound/reply-enqueue-media.ts',
  'src/openclaw/channel-runtime-contracts.ts',
  'src/plugin/bridge-ack-facade.ts',
  'src/plugin/bridge-connection-facade.ts',
  'src/plugin/bridge-diagnostics-facade.ts',
  'src/plugin/bridge-drain-facade.ts',
  'src/plugin/bridge-extended-diagnostics-facade.ts',
  'src/plugin/bridge-lifecycle.ts',
  'src/plugin/bridge-media-facade.ts',
  'src/plugin/bridge-outbox-facade.ts',
  'src/plugin/bridge-runtime-helpers.ts',
  'src/plugin/bridge-runtime-snapshots.ts',
  'src/plugin/bridge-runtime-surface-facade.ts',
  'src/plugin/bridge-status-facade.ts',
  'src/plugin/bridge-status-worker-facade.ts',
  'src/plugin/bridge-support-runtime.ts',
  'src/plugin/channel-runtime-builders-delivery.ts',
  'src/plugin/channel-runtime-builders-status.ts',
  'src/plugin/connection-handlers-helpers.ts',
  'src/plugin/connection-state-helpers.ts',
  'src/plugin/error-message.ts',
  'src/plugin/file-transfer-orchestrator-chunk.ts',
  'src/plugin/outbox-unified-push-flow.ts',
  'src/plugin/runtime-diagnostics-assembler.ts',
  'src/plugin/runtime-diagnostics-helpers.ts',
  'src/plugin/runtime-diagnostics-payload-builders.ts',
  'src/plugin/scene-registry.ts',
];

const requiredPackFiles = [
  'LICENSE',
  'README.md',
  'package.json',
  ...requiredRootFiles,
  ...requiredScriptFiles,
  ...requiredSourceFiles,
];

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const raw = JSON.parse(output);
const pack = Array.isArray(raw)
  ? raw[0]
  : raw[Object.keys(raw).find((k) => k.startsWith('@')) || Object.keys(raw)[0]];
const packedFiles = new Set((pack?.files ?? []).map((file) => file.path));
const missing = requiredPackFiles.filter((file) => !packedFiles.has(file));
const channelSource = fs.readFileSync(path.join(root, 'src/channel.ts'), 'utf8');
const channelPluginSurfaceSource = fs.readFileSync(
  path.join(root, 'src/plugin/channel-plugin-surface-group.ts'),
  'utf8',
);
const messagePolicySource = fs.readFileSync(
  path.join(root, 'src/plugin/message-policy.ts'),
  'utf8',
);
const messageSendSource = fs.readFileSync(path.join(root, 'src/plugin/message-send.ts'), 'utf8');
const channelPluginSurfaceCombined = `${channelSource}\n${channelPluginSurfaceSource}`;
const channelMessageChecks = {
  registered: channelPluginSurfaceCombined.includes('message: {'),
  text:
    channelPluginSurfaceCombined.includes('createBncrMessageSend') &&
    messageSendSource.includes('channelMessageSendText'),
  media:
    channelPluginSurfaceCombined.includes('createBncrMessageSend') &&
    messageSendSource.includes('channelMessageSendMedia'),
  payload:
    channelPluginSurfaceCombined.includes('createBncrMessageSend') &&
    messageSendSource.includes('channelMessageSendPayload'),
  manualAck:
    channelPluginSurfaceCombined.includes('BNCR_MESSAGE_RECEIVE_POLICY') &&
    messagePolicySource.includes("defaultAckPolicy: 'manual'") &&
    messagePolicySource.includes("supportedAckPolicies: ['manual']"),
  genericActionsPreserved: channelPluginSurfaceCombined.includes('actions: messageActions'),
  noDurableFinal:
    !channelPluginSurfaceCombined.includes('durableFinal:') &&
    !messagePolicySource.includes('durableFinal:'),
};
const channelMessageOk = Object.values(channelMessageChecks).every(Boolean);

const result = {
  ok: missing.length === 0 && pkg.peerDependencies?.openclaw === '>=2026.5.27' && channelMessageOk,
  package: pack?.id,
  entryCount: pack?.entryCount,
  missing,
  openclaw: pkg.peerDependencies?.openclaw,
  channelMessageChecks,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
