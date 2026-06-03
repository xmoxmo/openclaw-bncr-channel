import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const requiredFiles = [
  'index.ts',
  'openclaw.plugin.json',
  'src/channel.ts',
  'src/core/types.ts',
  'src/core/accounts.ts',
  'src/core/targets.ts',
  'src/core/status.ts',
  'src/core/probe.ts',
  'src/core/config-schema.ts',
  'src/core/policy.ts',
  'src/core/permissions.ts',
  'src/messaging/inbound/parse.ts',
  'src/messaging/inbound/gate.ts',
  'src/messaging/inbound/dispatch.ts',
  'src/messaging/outbound/send.ts',
  'src/messaging/outbound/media.ts',
  'src/messaging/outbound/actions.ts',
  'src/messaging/outbound/durable-message-adapter.ts',
  'src/messaging/outbound/durable-queue-adapter.ts',
  'src/openclaw/config-runtime.ts',
  'src/openclaw/inbound-session-runtime.ts',
  'src/openclaw/ingress-runtime.ts',
  'src/openclaw/media-runtime.ts',
  'src/openclaw/reply-runtime.ts',
  'src/openclaw/routing-runtime.ts',
  'src/openclaw/sdk-helpers.ts',
  'src/openclaw/session-route-runtime.ts',
];

const readPackageVersion = () => {
  const pkgPath = path.join(root, 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  return typeof pkg?.version === 'string' ? pkg.version.trim() : '';
};

const requiredOpenClawSdkSubpaths = [
  'openclaw/plugin-sdk/channel-outbound',
  'openclaw/plugin-sdk/channel-message',
  'openclaw/plugin-sdk/routing',
  'openclaw/plugin-sdk/conversation-runtime',
  'openclaw/plugin-sdk/session-store-runtime',
  'openclaw/plugin-sdk/core',
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
