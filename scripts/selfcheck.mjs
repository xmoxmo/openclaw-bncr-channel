import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const requiredRootFiles = ['index.ts', 'openclaw.plugin.json'];

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

const requiredFiles = [...requiredRootFiles, ...requiredSourceFiles];

const readPackageVersion = () => {
  const pkgPath = path.join(root, 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  return typeof pkg?.version === 'string' ? pkg.version.trim() : '';
};

const requiredOpenClawSdkSubpaths = [
  'openclaw/plugin-sdk',
  'openclaw/plugin-sdk/boolean-param',
  'openclaw/plugin-sdk/channel-outbound',
  'openclaw/plugin-sdk/channel-ingress-runtime',
  'openclaw/plugin-sdk/channel-message',
  'openclaw/plugin-sdk/routing',
  'openclaw/plugin-sdk/conversation-runtime',
  'openclaw/plugin-sdk/session-store-runtime',
  'openclaw/plugin-sdk/core',
  'openclaw/plugin-sdk/json-store',
  'openclaw/plugin-sdk/param-readers',
  'openclaw/plugin-sdk/security-runtime',
  'openclaw/plugin-sdk/status-helpers',
  'openclaw/plugin-sdk/tool-send',
];

const resolveOpenClawSdkSubpaths = () => {
  return requiredOpenClawSdkSubpaths.map((specifier) => {
    try {
      return { specifier, ok: true, path: require.resolve(specifier) };
    } catch (err) {
      return {
        specifier,
        ok: false,
        error: err && typeof err === 'object' && 'code' in err ? err.code : String(err),
      };
    }
  });
};

const validateVersionPolicy = (version) => {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return {
      ok: false,
      reason: 'version must be strict semver x.y.z',
      version,
    };
  }

  const patch = Number.parseInt(match[3], 10);
  if (patch > 9) {
    return {
      ok: false,
      reason: 'patch version must stay within 0-9; bump minor instead',
      version,
    };
  }

  return { ok: true, version };
};

const missing = requiredFiles.filter((rel) => !fs.existsSync(path.join(root, rel)));
const version = readPackageVersion();
const versionPolicy = validateVersionPolicy(version);
const sdkSubpaths = resolveOpenClawSdkSubpaths();
const missingSdkSubpaths = sdkSubpaths.filter((entry) => !entry.ok);
const result = {
  ok: missing.length === 0 && versionPolicy.ok && missingSdkSubpaths.length === 0,
  checkedRoot: root,
  requiredCount: requiredFiles.length,
  missing,
  version,
  versionPolicy,
  sdkSubpaths,
};

console.log(JSON.stringify(result, null, 2));
if (missing.length > 0 || !versionPolicy.ok || missingSdkSubpaths.length > 0) process.exit(1);
