import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const requiredPackFiles = [
  'README.md',
  'index.ts',
  'openclaw.plugin.json',
  'package.json',
  'scripts/selfcheck.mjs',
  'scripts/check-register-drift.mjs',
  'src/channel.ts',
  'src/plugin/config.ts',
  'src/plugin/message-policy.ts',
  'src/plugin/messaging.ts',
  'src/plugin/gateway-runtime.ts',
  'src/plugin/message-send.ts',
  'src/plugin/outbound.ts',
  'src/plugin/setup.ts',
  'src/plugin/status.ts',
  'src/runtime/outbound-ack-timeout.ts',
  'src/runtime/outbound-flags.ts',
  'src/runtime/outbox-transitions.ts',
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
