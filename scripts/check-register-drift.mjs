import { execFileSync } from 'node:child_process';

const readNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const args = process.argv.slice(2);
const options = {
  durationSec: 300,
  intervalSec: 15,
  accountId: 'Primary',
  gatewayBin: 'openclaw',
};

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--duration-sec') options.durationSec = readNumber(args[++i], options.durationSec);
  else if (arg === '--interval-sec')
    options.intervalSec = readNumber(args[++i], options.intervalSec);
  else if (arg === '--account-id') options.accountId = args[++i] || options.accountId;
  else if (arg === '--gateway-bin') options.gatewayBin = args[++i] || options.gatewayBin;
  else if (arg === '--help' || arg === '-h') {
    console.log(
      'Usage: node ./scripts/check-register-drift.mjs [--duration-sec 300] [--interval-sec 15] [--account-id Primary] [--gateway-bin openclaw]\n\nSamples bncr.diagnostics over time and reports whether register counters drift after warmup.',
    );
    process.exit(0);
  }
}

if (options.durationSec <= 0) throw new Error('durationSec must be > 0');
if (options.intervalSec <= 0) throw new Error('intervalSec must be > 0');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchDiagnostics = () => {
  const raw = execFileSync(
    options.gatewayBin,
    [
      'gateway',
      'call',
      'bncr.diagnostics',
      '--json',
      '--params',
      JSON.stringify({ accountId: options.accountId }),
    ],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(raw);
  const reg = parsed?.diagnostics?.register || {};
  const summary = reg?.traceSummary || {};
  return {
    now: parsed?.now ?? Date.now(),
    registerCount: reg?.registerCount ?? null,
    apiGeneration: reg?.apiGeneration ?? null,
    apiInstanceId: reg?.apiInstanceId ?? null,
    registryFingerprint: reg?.registryFingerprint ?? null,
    warmupRegisterCount: summary?.warmupRegisterCount ?? null,
    postWarmupRegisterCount: summary?.postWarmupRegisterCount ?? null,
    unexpectedRegisterAfterWarmup: summary?.unexpectedRegisterAfterWarmup ?? null,
    lastUnexpectedRegisterAt: summary?.lastUnexpectedRegisterAt ?? null,
    sourceBuckets: summary?.sourceBuckets ?? null,
  };
};

const startedAt = Date.now();
const samples = [];
const deadline = startedAt + options.durationSec * 1000;

while (true) {
  const sample = fetchDiagnostics();
  samples.push(sample);
  const nextAt = Date.now() + options.intervalSec * 1000;
  if (nextAt > deadline) break;
  await sleep(Math.max(0, nextAt - Date.now()));
}

const first = samples[0] || {};
const last = samples[samples.length - 1] || {};
const deltaRegisterCount = (last.registerCount ?? 0) - (first.registerCount ?? 0);
const deltaApiGeneration = (last.apiGeneration ?? 0) - (first.apiGeneration ?? 0);
const deltaPostWarmupRegisterCount =
  (last.postWarmupRegisterCount ?? 0) - (first.postWarmupRegisterCount ?? 0);
const historicalWarmupExternalDrift = Boolean(first.unexpectedRegisterAfterWarmup);
const newWarmupExternalDriftDuringWindow = deltaPostWarmupRegisterCount > 0;
const newDriftDuringWindow =
  deltaRegisterCount > 0 || deltaApiGeneration > 0 || newWarmupExternalDriftDuringWindow;
const driftDetected = historicalWarmupExternalDrift || newDriftDuringWindow;

const result = {
  ok: true,
  accountId: options.accountId,
  durationSec: options.durationSec,
  intervalSec: options.intervalSec,
  startedAt,
  endedAt: Date.now(),
  sampleCount: samples.length,
  first,
  last,
  delta: {
    registerCount: deltaRegisterCount,
    apiGeneration: deltaApiGeneration,
    postWarmupRegisterCount: deltaPostWarmupRegisterCount,
  },
  historicalWarmupExternalDrift,
  newWarmupExternalDriftDuringWindow,
  newDriftDuringWindow,
  driftDetected,
  conclusion: newDriftDuringWindow
    ? 'new register drift was observed during this sampling window'
    : historicalWarmupExternalDrift
      ? 'no new drift during this window, but warmup-external drift had already happened before sampling began'
      : 'register counters stayed stable during this window and no warmup-external drift was flagged',
  samples,
};

console.log(JSON.stringify(result, null, 2));
