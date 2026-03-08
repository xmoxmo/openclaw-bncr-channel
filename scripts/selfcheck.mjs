import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

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
];

const missing = requiredFiles.filter((rel) => !fs.existsSync(path.join(root, rel)));
const result = {
  ok: missing.length === 0,
  checkedRoot: root,
  requiredCount: requiredFiles.length,
  missing,
};

console.log(JSON.stringify(result, null, 2));
if (missing.length > 0) process.exit(1);
