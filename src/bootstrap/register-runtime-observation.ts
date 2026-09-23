export const REGISTRY_RUNTIME_OBSERVATION_TIMEOUT_MS = 30_000;
export const REGISTRY_RUNTIME_OBSERVATION_POLL_MS = 5_000;

export type RegistryRuntimeObservationPhase = 'awaiting' | 'polling' | 'ready' | 'retired';

export type RegistryRuntimeProbe = {
  serviceRunning?: boolean;
  channelRunning?: boolean;
  activeChannelAccounts?: number;
};

export type RegistryRuntimeObservation = {
  phase: RegistryRuntimeObservationPhase;
  startedAt: number;
  deadlineAt: number;
  pollingStartedAt: number | null;
  readyAt: number | null;
  retiredAt: number | null;
  lastProbeAt: number | null;
  probeCount: number;
  serviceObservedAt: number | null;
  channelObservedAt: number | null;
};

export type RegistryRuntimeObservationDecision = {
  observation: RegistryRuntimeObservation;
  action: 'wait' | 'poll' | 'ready' | 'retired';
  transitionedToPolling: boolean;
  transitionedToReady: boolean;
};

function finiteTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function createRegistryRuntimeObservation(now: number): RegistryRuntimeObservation {
  return {
    phase: 'awaiting',
    startedAt: now,
    deadlineAt: now + REGISTRY_RUNTIME_OBSERVATION_TIMEOUT_MS,
    pollingStartedAt: null,
    readyAt: null,
    retiredAt: null,
    lastProbeAt: null,
    probeCount: 0,
    serviceObservedAt: null,
    channelObservedAt: null,
  };
}

export function normalizeRegistryRuntimeObservation(
  value: unknown,
): RegistryRuntimeObservation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const phase = source.phase;
  if (phase !== 'awaiting' && phase !== 'polling' && phase !== 'ready' && phase !== 'retired') {
    return undefined;
  }
  const startedAt = finiteTimestamp(source.startedAt);
  const deadlineAt = finiteTimestamp(source.deadlineAt);
  if (startedAt === null || deadlineAt === null) return undefined;
  return {
    phase,
    startedAt,
    deadlineAt,
    pollingStartedAt: finiteTimestamp(source.pollingStartedAt),
    readyAt: finiteTimestamp(source.readyAt),
    retiredAt: finiteTimestamp(source.retiredAt),
    lastProbeAt: finiteTimestamp(source.lastProbeAt),
    probeCount: nonNegativeInteger(source.probeCount),
    serviceObservedAt: finiteTimestamp(source.serviceObservedAt),
    channelObservedAt: finiteTimestamp(source.channelObservedAt),
  };
}

function retireObservation(
  observation: RegistryRuntimeObservation,
  now: number,
): RegistryRuntimeObservationDecision {
  return {
    observation: {
      ...observation,
      phase: 'retired',
      retiredAt: observation.retiredAt ?? now,
      lastProbeAt: now,
      probeCount: observation.probeCount + 1,
    },
    action: 'retired',
    transitionedToPolling: false,
    transitionedToReady: false,
  };
}

export function evaluateRegistryRuntimeObservation(args: {
  observation: RegistryRuntimeObservation;
  now: number;
  lifecycleActive: boolean;
  probe: RegistryRuntimeProbe;
}): RegistryRuntimeObservationDecision {
  const { observation, now, lifecycleActive, probe } = args;
  if (observation.phase === 'retired') {
    return {
      observation,
      action: 'retired',
      transitionedToPolling: false,
      transitionedToReady: false,
    };
  }
  if (!lifecycleActive) {
    return retireObservation(observation, now);
  }
  if (observation.phase === 'ready') {
    return {
      observation,
      action: 'ready',
      transitionedToPolling: false,
      transitionedToReady: false,
    };
  }

  const serviceRunning = probe.serviceRunning === true;
  const channelRunning = probe.channelRunning === true || (probe.activeChannelAccounts ?? 0) > 0;
  const serviceObservedAt = observation.serviceObservedAt ?? (serviceRunning ? now : null);
  const channelObservedAt = observation.channelObservedAt ?? (channelRunning ? now : null);
  const observed = {
    ...observation,
    lastProbeAt: now,
    probeCount: observation.probeCount + 1,
    serviceObservedAt,
    channelObservedAt,
  };

  if (serviceRunning && channelRunning) {
    return {
      observation: {
        ...observed,
        phase: 'ready',
        readyAt: observed.readyAt ?? now,
      },
      action: 'ready',
      transitionedToPolling: false,
      transitionedToReady: true,
    };
  }

  if (now >= observation.deadlineAt) {
    return {
      observation: {
        ...observed,
        phase: 'polling',
        pollingStartedAt: observed.pollingStartedAt ?? now,
      },
      action: 'poll',
      transitionedToPolling: observation.phase === 'awaiting',
      transitionedToReady: false,
    };
  }

  return {
    observation: observed,
    action: 'wait',
    transitionedToPolling: false,
    transitionedToReady: false,
  };
}
