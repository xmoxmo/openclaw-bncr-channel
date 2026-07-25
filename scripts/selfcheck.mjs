import { execFileSync } from 'node:child_process';
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
  'src/bootstrap/channel-plugin-runtime.ts',
  'src/bootstrap/cli.ts',
  'src/bootstrap/register-runtime-gateway.ts',
  'src/bootstrap/register-runtime-helpers.ts',
  'src/bootstrap/register-runtime-singleton.ts',
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
  'src/core/value-sanitize.ts',
  'src/messaging/inbound/commands.ts',
  'src/messaging/inbound/context-facts.ts',
  'src/messaging/inbound/contracts.ts',
  'src/messaging/inbound/dispatch-prep.ts',
  'src/messaging/inbound/dispatch.ts',
  'src/messaging/inbound/gate.ts',
  'src/messaging/inbound/group-history.ts',
  'src/messaging/inbound/last-route.ts',
  'src/messaging/inbound/media-url-download.ts',
  'src/messaging/inbound/native-command-runtime.ts',
  'src/messaging/inbound/native-command.ts',
  'src/messaging/inbound/native-reply-delivery.ts',
  'src/messaging/inbound/parse.ts',
  'src/messaging/inbound/remote-media.ts',
  'src/messaging/inbound/reply-config.ts',
  'src/messaging/inbound/reply-dispatch-serial.ts',
  'src/messaging/inbound/reply-dispatch.ts',
  'src/messaging/inbound/runtime-compat.ts',
  'src/messaging/inbound/scene-admin.ts',
  'src/messaging/inbound/session-label.ts',
  'src/messaging/inbound/session-meta-task.ts',
  'src/messaging/inbound/turn-context.ts',
  'src/messaging/outbound/actions.ts',
  'src/messaging/outbound/diagnostics-debug-builders.ts',
  'src/messaging/outbound/diagnostics.ts',
  'src/messaging/outbound/durable-queue-adapter.ts',
  'src/messaging/outbound/marker-parser.ts',
  'src/messaging/outbound/media-dedupe.ts',
  'src/messaging/outbound/media.ts',
  'src/messaging/outbound/normalize-outbound-send.ts',
  'src/messaging/outbound/queue-selectors.ts',
  'src/messaging/outbound/reasons.ts',
  'src/messaging/outbound/reply-enqueue-media.ts',
  'src/messaging/outbound/reply-enqueue.ts',
  'src/messaging/outbound/reply-target-policy.ts',
  'src/messaging/outbound/retry-policy.ts',
  'src/messaging/outbound/session-route.ts',
  'src/messaging/outbound/target-resolver.ts',
  'src/openclaw/channel-runtime-contracts.ts',
  'src/openclaw/config-runtime.ts',
  'src/openclaw/inbound-session-runtime.ts',
  'src/openclaw/media-runtime.ts',
  'src/openclaw/reply-runtime.ts',
  'src/openclaw/routing-runtime.ts',
  'src/openclaw/runtime-surface.ts',
  'src/openclaw/sdk-helpers.ts',
  'src/openclaw/session-route-runtime.ts',
  'src/plugin/ack-outbox-runtime-group.ts',
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
  'src/plugin/bridge-surface-handlers-group.ts',
  'src/plugin/bridge-surface-helpers.ts',
  'src/plugin/capabilities.ts',
  'src/plugin/channel-components.ts',
  'src/plugin/channel-inbound-helpers.ts',
  'src/plugin/channel-plugin-bridge-group.ts',
  'src/plugin/channel-plugin-surface-group.ts',
  'src/plugin/channel-runtime-builders-delivery.ts',
  'src/plugin/channel-runtime-builders-status.ts',
  'src/plugin/channel-runtime-builders.ts',
  'src/plugin/channel-runtime-constants.ts',
  'src/plugin/channel-runtime-types.ts',
  'src/plugin/channel-send.ts',
  'src/plugin/channel-utils.ts',
  'src/plugin/config.ts',
  'src/plugin/connection-handlers-helpers.ts',
  'src/plugin/connection-handlers.ts',
  'src/plugin/connection-state-helpers.ts',
  'src/plugin/connection-state-runtime-group.ts',
  'src/plugin/connection-state.ts',
  'src/plugin/diagnostics-handlers.ts',
  'src/plugin/error-message.ts',
  'src/plugin/file-ack-runtime.ts',
  'src/plugin/file-inbound-abort.ts',
  'src/plugin/file-inbound-chunk.ts',
  'src/plugin/file-inbound-complete.ts',
  'src/plugin/file-inbound-handlers.ts',
  'src/plugin/file-inbound-init.ts',
  'src/plugin/file-inbound-runtime.ts',
  'src/plugin/file-inbound-state.ts',
  'src/plugin/file-transfer-logs.ts',
  'src/plugin/file-transfer-orchestrator-chunk.ts',
  'src/plugin/file-transfer-orchestrator.ts',
  'src/plugin/file-transfer-runtime-group.ts',
  'src/plugin/file-transfer-send.ts',
  'src/plugin/file-transfer-setup.ts',
  'src/plugin/gateway-event-context.ts',
  'src/plugin/gateway-methods.ts',
  'src/plugin/gateway-runtime.ts',
  'src/plugin/inbound-acceptance.ts',
  'src/plugin/inbound-handlers.ts',
  'src/plugin/inbound-surface-handlers-group.ts',
  'src/plugin/media-dedupe-runtime.ts',
  'src/plugin/media-orchestrators-runtime-group.ts',
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
  'src/plugin/outbox-unified-push-flow.ts',
  'src/plugin/runtime-diagnostics-assembler.ts',
  'src/plugin/runtime-diagnostics-helpers.ts',
  'src/plugin/runtime-diagnostics-payload-builders.ts',
  'src/plugin/runtime-diagnostics-snapshot.ts',
  'src/plugin/scene-registry.ts',
  'src/plugin/setup.ts',
  'src/plugin/state-store.ts',
  'src/plugin/state-transient-runtime-group.ts',
  'src/plugin/status-runtime.ts',
  'src/plugin/status.ts',
  'src/plugin/target-runtime.ts',
  'src/plugin/target-status-runtime-group.ts',
  'src/plugin/transient-state-runtime.ts',
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

const readNpmLatestVersion = (packageName) => {
  try {
    const raw = execFileSync('npm', ['view', packageName, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    }).trim();
    return raw || null;
  } catch {
    return null;
  }
};

const requiredOpenClawSdkSubpaths = [
  'openclaw/plugin-sdk',
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

const validateVersionPolicy = (version, latestVersion) => {
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

  // Prevent jumping minor when current minor still has unused patch slots
  if (latestVersion) {
    const lm = latestVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (lm) {
      const vMajor = Number.parseInt(match[1], 10);
      const vMinor = Number.parseInt(match[2], 10);
      const lMajor = Number.parseInt(lm[1], 10);
      const lMinor = Number.parseInt(lm[2], 10);
      const lPatch = Number.parseInt(lm[3], 10);

      // Version unchanged
      if (vMajor === lMajor && vMinor === lMinor && patch === lPatch) {
        return { ok: false, reason: `version unchanged: ${version}`, version };
      }

      // Downgrade: any component decreased
      if (
        vMajor < lMajor ||
        (vMajor === lMajor && vMinor < lMinor) ||
        (vMajor === lMajor && vMinor === lMinor && patch < lPatch)
      ) {
        return { ok: false, reason: `downgrade from ${latestVersion} to ${version}`, version };
      }

      // Patch bump: same major and minor, patch must increment by exactly +1
      if (vMajor === lMajor && vMinor === lMinor) {
        if (patch === lPatch + 1) return { ok: true, version };
        return {
          ok: false,
          reason: `patch jump from ${latestVersion} to ${version} (delta=${patch - lPatch}); expected ${lMajor}.${lMinor}.${lPatch + 1}`,
          version,
        };
      }

      // Minor bump: same major, minor + 1
      if (vMajor === lMajor && vMinor === lMinor + 1) {
        if (lPatch === 9 && patch === 0) return { ok: true, version };
        if (lPatch !== 9)
          return {
            ok: false,
            reason: `minor bumped from ${latestVersion} to ${version} but ${9 - lPatch} patch slots remain in ${lMajor}.${lMinor}; prefer ${lMajor}.${lMinor}.${lPatch + 1}`,
            version,
          };
        return {
          ok: false,
          reason: `minor bump must reset patch to 0; got ${vMajor}.${vMinor}.${patch}`,
          version,
        };
      }

      // Minor jumped by more than 1
      if (vMajor === lMajor && vMinor > lMinor + 1) {
        return {
          ok: false,
          reason: `minor jumped from ${latestVersion} to ${version}; expected ${lMajor}.${lMinor + 1}.0`,
          version,
        };
      }

      // Major bump: major + 1, requires previous minor fully exhausted
      if (vMajor === lMajor + 1) {
        if (lMinor === 9 && lPatch === 9 && vMinor === 0 && patch === 0)
          return { ok: true, version };
        if (lMinor !== 9 || lPatch !== 9)
          return {
            ok: false,
            reason: `major bumped from ${latestVersion} to ${version} but previous major series not exhausted; expected ${lMajor + 1}.0.0 after ${lMajor}.9.9`,
            version,
          };
        return {
          ok: false,
          reason: `major bump must reset to .0.0; got ${vMajor}.${vMinor}.${patch}`,
          version,
        };
      }

      // Major jumped by more than 1
      if (vMajor > lMajor + 1) {
        return {
          ok: false,
          reason: `major jumped from ${latestVersion} to ${version}; expected ${lMajor + 1}.0.0`,
          version,
        };
      }
    }
  }

  return { ok: true, version };
};

const missing = requiredFiles.filter((rel) => !fs.existsSync(path.join(root, rel)));
const version = readPackageVersion();
const packageName = '@xmoxmo/bncr';
const latestVersion = readNpmLatestVersion(packageName);
const versionPolicy = validateVersionPolicy(version, latestVersion);
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
