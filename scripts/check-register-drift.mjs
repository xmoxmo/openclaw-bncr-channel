import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const readNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const readText = (value, fallback) => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const DEFAULT_OPTIONS = {
  durationSec: 300,
  intervalSec: 15,
  accountId: 'Primary',
  gatewayBin: 'openclaw',
  gatewayTimeoutMs: 30_000,
};

export function parseCheckRegisterDriftOptions(args, defaults = DEFAULT_OPTIONS) {
  const options = { ...defaults };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--duration-sec') options.durationSec = readNumber(args[++i], options.durationSec);
    else if (arg === '--interval-sec')
      options.intervalSec = readNumber(args[++i], options.intervalSec);
    else if (arg === '--account-id') options.accountId = readText(args[++i], options.accountId);
    else if (arg === '--gateway-bin') options.gatewayBin = readText(args[++i], options.gatewayBin);
    else if (arg === '--gateway-timeout-ms')
      options.gatewayTimeoutMs = readNumber(args[++i], options.gatewayTimeoutMs);
    else if (arg === '--help' || arg === '-h') options.help = true;
  }

  return options;
}

const printHelp = () => {
  console.log(
    'Usage: node ./scripts/check-register-drift.mjs [--duration-sec 300] [--interval-sec 15] [--account-id Primary] [--gateway-bin openclaw] [--gateway-timeout-ms 30000]\n\nSamples bncr.diagnostics over time and reports whether register counters drift after warmup.',
  );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const summarizeExecOutput = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

const fetchDiagnostics = (options) => {
  let raw;
  try {
    raw = execFileSync(
      options.gatewayBin,
      [
        'gateway',
        'call',
        'bncr.diagnostics',
        '--json',
        '--timeout',
        String(options.gatewayTimeoutMs),
        '--params',
        JSON.stringify({ accountId: options.accountId }),
      ],
      { encoding: 'utf8' },
    );
  } catch (error) {
    const detail = [
      `gatewayTimeoutMs=${options.gatewayTimeoutMs}`,
      `status=${error?.status ?? 'unknown'}`,
      `stderr=${summarizeExecOutput(error?.stderr) || '-'}`,
      `stdout=${summarizeExecOutput(error?.stdout) || '-'}`,
    ].join(' ');
    throw new Error(`bncr.diagnostics gateway call failed (${detail})`, { cause: error });
  }
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

export async function runCheckRegisterDrift(options) {
  if (options.durationSec <= 0) throw new Error('durationSec must be > 0');
  if (options.intervalSec <= 0) throw new Error('intervalSec must be > 0');

  const startedAt = Date.now();
  const samples = [];
  const deadline = startedAt + options.durationSec * 1000;

  while (true) {
    const sample = fetchDiagnostics(options);
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

  return {
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
}

async function main() {
  const options = parseCheckRegisterDriftOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  console.log(JSON.stringify(await runCheckRegisterDrift(options), null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
