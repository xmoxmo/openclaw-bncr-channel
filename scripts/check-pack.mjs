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
  'src/channel.ts',
  'src/core/types.ts',
  'src/core/accounts.ts',
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
  'src/core/outbox-text-push-prep.ts',
  'src/core/outbox-text-push-success.ts',
  'src/core/persisted-outbox-entry.ts',
  'src/core/targets.ts',
  'src/core/status.ts',
  'src/core/status-meta.ts',
  'src/core/probe.ts',
  'src/core/config-schema.ts',
  'src/core/policy.ts',
  'src/core/permissions.ts',
  'src/core/register-trace.ts',
  'src/messaging/inbound/commands.ts',
  'src/messaging/inbound/context-facts.ts',
  'src/messaging/inbound/parse.ts',
  'src/messaging/inbound/gate.ts',
  'src/messaging/inbound/dispatch.ts',
  'src/messaging/inbound/last-route.ts',
  'src/messaging/inbound/native-command.ts',
  'src/messaging/inbound/native-reply-delivery.ts',
  'src/messaging/inbound/reply-config.ts',
  'src/messaging/inbound/runtime-compat.ts',
  'src/messaging/inbound/session-label.ts',
  'src/messaging/outbound/send.ts',
  'src/messaging/outbound/media.ts',
  'src/messaging/outbound/actions.ts',
  'src/messaging/outbound/build-send-action.ts',
  'src/messaging/outbound/diagnostics.ts',
  'src/messaging/outbound/durable-message-adapter.ts',
  'src/messaging/outbound/durable-queue-adapter.ts',
  'src/messaging/outbound/media-dedupe.ts',
  'src/messaging/outbound/queue-selectors.ts',
  'src/messaging/outbound/reasons.ts',
  'src/messaging/outbound/reply-enqueue.ts',
  'src/messaging/outbound/reply-target-policy.ts',
  'src/messaging/outbound/retry-policy.ts',
  'src/messaging/outbound/send-params.ts',
  'src/messaging/outbound/session-route.ts',
  'src/messaging/outbound/target-resolver.ts',
  'src/openclaw/config-runtime.ts',
  'src/openclaw/inbound-session-runtime.ts',
  'src/openclaw/ingress-runtime.ts',
  'src/openclaw/media-runtime.ts',
  'src/openclaw/reply-runtime.ts',
  'src/openclaw/routing-runtime.ts',
  'src/openclaw/runtime-surface.ts',
  'src/openclaw/sdk-helpers.ts',
  'src/openclaw/session-route-runtime.ts',
  'src/plugin/capabilities.ts',
  'src/plugin/config.ts',
  'src/plugin/gateway-methods.ts',
  'src/plugin/gateway-runtime.ts',
  'src/plugin/message-policy.ts',
  'src/plugin/message-send.ts',
  'src/plugin/messaging.ts',
  'src/plugin/meta.ts',
  'src/plugin/outbound.ts',
  'src/plugin/setup.ts',
  'src/plugin/status.ts',
  'src/runtime/log-dedupe.ts',
  'src/runtime/outbound-ack-timeout.ts',
  'src/runtime/outbound-flags.ts',
  'src/runtime/outbox-transitions.ts',
  'src/runtime/register-trace-runtime.ts',
  'src/runtime/status-snapshots.ts',
  'src/runtime/status-worker.ts',
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
const [pack] = JSON.parse(output);
const packedFiles = new Set((pack?.files ?? []).map((file) => file.path));
const missing = requiredPackFiles.filter((file) => !packedFiles.has(file));
const channelSource = fs.readFileSync(path.join(root, 'src/channel.ts'), 'utf8');
const messagePolicySource = fs.readFileSync(
  path.join(root, 'src/plugin/message-policy.ts'),
  'utf8',
);
const messageSendSource = fs.readFileSync(path.join(root, 'src/plugin/message-send.ts'), 'utf8');
const channelMessageChecks = {
  registered: channelSource.includes('message: {'),
  text:
    channelSource.includes('createBncrMessageSend') &&
    messageSendSource.includes('channelMessageSendText'),
  media:
    channelSource.includes('createBncrMessageSend') &&
    messageSendSource.includes('channelMessageSendMedia'),
  payload:
    channelSource.includes('createBncrMessageSend') &&
    messageSendSource.includes('channelMessageSendPayload'),
  manualAck:
    channelSource.includes('BNCR_MESSAGE_RECEIVE_POLICY') &&
    messagePolicySource.includes("defaultAckPolicy: 'manual'") &&
    messagePolicySource.includes("supportedAckPolicies: ['manual']"),
  genericActionsPreserved: channelSource.includes('actions: messageActions'),
  noDurableFinal:
    !channelSource.includes('durableFinal:') && !messagePolicySource.includes('durableFinal:'),
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
