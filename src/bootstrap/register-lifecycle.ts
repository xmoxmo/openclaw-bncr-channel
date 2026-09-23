export type LifecyclePhase = 'registering' | 'active' | 'stopping' | 'stopped' | 'failed';

export type LifecycleKey = {
  generation: number;
  apiInstanceId: string;
  registryFingerprint: string;
};

export type BridgeGeneration = {
  moduleEpoch: string;
  bridgeFactoryId: string;
  pluginVersion: string;
  registrationMode: string;
  pluginRoot: string;
  pluginFile: string;
};

export type LifecycleOwner = {
  key: LifecycleKey;
  bridgeGeneration: BridgeGeneration;
  phase: LifecyclePhase;
  startedAt: number | null;
  stopRequestedAt: number | null;
  stoppedAt: number | null;
  failure: string | null;
};

export type LifecycleRetirementOutcome =
  | { ok: true }
  | {
      ok: false;
      error: string;
    };

export type LifecycleAdoptionDecision =
  | {
      kind: 'initialize';
      owner: LifecycleOwner;
      reason: 'no-active-lifecycle';
    }
  | {
      kind: 'duplicate';
      owner: LifecycleOwner;
      reason:
        | 'active-owner'
        | 'pending-successor'
        | 'lifecycle-stopping'
        | 'same-lifecycle-stopped';
    }
  | {
      kind: 'takeover';
      owner: LifecycleOwner;
      mode: 'reuse' | 'replace';
      reason: 'bridge-generation-reused' | 'bridge-generation-changed';
    }
  | {
      kind: 'defer';
      owner: LifecycleOwner;
      predecessorGeneration: number;
      mode: 'reuse' | 'replace';
      reason: 'predecessor-stopping';
    }
  | {
      kind: 'reject';
      owner: LifecycleOwner;
      reason:
        | 'predecessor-failed'
        | 'pending-successor-conflict'
        | 'registration-generation-conflict'
        | 'registration-failed'
        | 'registration-in-progress';
    };

export type RegisterLifecycleState = {
  nextGeneration: number;
  active?: LifecycleOwner;
  pending?: LifecycleOwner;
  pendingMode?: 'reuse' | 'replace';
  retirement?: Promise<LifecycleRetirementOutcome>;
  resolveRetirement?: (outcome: LifecycleRetirementOutcome) => void;
  staleCallbackSuppressions: number;
};

export type LifecyclePlanInput = {
  apiInstanceId: string;
  registryFingerprint: string;
  bridgeGeneration: BridgeGeneration;
  now: number;
};

function normalizeString(value: unknown, fallback = 'unknown') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

export function createRegisterLifecycleState(): RegisterLifecycleState {
  return {
    nextGeneration: 1,
    staleCallbackSuppressions: 0,
  };
}

export function sameLifecycleRegistration(left?: LifecycleKey, right?: LifecycleKey) {
  if (!left || !right) return false;
  return (
    left.apiInstanceId === right.apiInstanceId &&
    left.registryFingerprint === right.registryFingerprint
  );
}

export function sameBridgeGeneration(left?: BridgeGeneration, right?: BridgeGeneration) {
  if (!left || !right) return false;
  return (
    left.moduleEpoch === right.moduleEpoch &&
    left.bridgeFactoryId === right.bridgeFactoryId &&
    left.pluginVersion === right.pluginVersion &&
    left.registrationMode === right.registrationMode &&
    left.pluginRoot === right.pluginRoot &&
    left.pluginFile === right.pluginFile
  );
}

export function getBridgeGenerationKey(generation: BridgeGeneration) {
  return [
    generation.moduleEpoch,
    generation.bridgeFactoryId,
    generation.pluginVersion,
    generation.registrationMode,
    generation.pluginRoot,
    generation.pluginFile,
  ].join('\u0000');
}

export function createLifecycleOwner(
  input: LifecyclePlanInput,
  generation: number,
  phase: LifecyclePhase,
): LifecycleOwner {
  return {
    key: {
      generation,
      apiInstanceId: normalizeString(input.apiInstanceId, 'unknown-api'),
      registryFingerprint: normalizeString(input.registryFingerprint, 'unknown-registry'),
    },
    bridgeGeneration: {
      moduleEpoch: normalizeString(input.bridgeGeneration.moduleEpoch),
      bridgeFactoryId: normalizeString(input.bridgeGeneration.bridgeFactoryId),
      pluginVersion: normalizeString(input.bridgeGeneration.pluginVersion),
      registrationMode: normalizeString(input.bridgeGeneration.registrationMode),
      pluginRoot: normalizeString(input.bridgeGeneration.pluginRoot),
      pluginFile: normalizeString(input.bridgeGeneration.pluginFile),
    },
    phase,
    startedAt: phase === 'active' ? input.now : null,
    stopRequestedAt: null,
    stoppedAt: null,
    failure: null,
  };
}

export function planLifecycleAdoption(
  state: RegisterLifecycleState,
  input: LifecyclePlanInput,
): LifecycleAdoptionDecision {
  const owner = createLifecycleOwner(input, state.nextGeneration, 'active');
  const active = state.active;

  if (!active) {
    return {
      kind: 'initialize',
      owner,
      reason: 'no-active-lifecycle',
    };
  }

  if (active.phase === 'failed') {
    return {
      kind: 'reject',
      owner,
      reason: 'predecessor-failed',
    };
  }

  if (state.pending) {
    const sameRegistration = sameLifecycleRegistration(state.pending.key, owner.key);
    const sameGeneration = sameBridgeGeneration(
      state.pending.bridgeGeneration,
      owner.bridgeGeneration,
    );
    if (sameRegistration && sameGeneration) {
      return {
        kind: 'duplicate',
        owner,
        reason: 'pending-successor',
      };
    }
    if (sameRegistration) {
      return {
        kind: 'reject',
        owner,
        reason: 'registration-generation-conflict',
      };
    }
    return {
      kind: 'reject',
      owner,
      reason: 'pending-successor-conflict',
    };
  }

  if (active.phase === 'active' || active.phase === 'registering') {
    if (
      sameLifecycleRegistration(active.key, owner.key) &&
      !sameBridgeGeneration(active.bridgeGeneration, owner.bridgeGeneration)
    ) {
      return {
        kind: 'reject',
        owner,
        reason: 'registration-generation-conflict',
      };
    }
    return {
      kind: 'duplicate',
      owner,
      reason: 'active-owner',
    };
  }

  if (active.phase === 'stopping') {
    const sameRegistration = sameLifecycleRegistration(active.key, owner.key);
    const sameGeneration = sameBridgeGeneration(active.bridgeGeneration, owner.bridgeGeneration);
    if (sameRegistration && sameGeneration) {
      return {
        kind: 'duplicate',
        owner,
        reason: 'lifecycle-stopping',
      };
    }
    if (sameRegistration) {
      return {
        kind: 'reject',
        owner,
        reason: 'registration-generation-conflict',
      };
    }
    return {
      kind: 'defer',
      owner,
      predecessorGeneration: active.key.generation,
      mode: sameBridgeGeneration(active.bridgeGeneration, owner.bridgeGeneration)
        ? 'reuse'
        : 'replace',
      reason: 'predecessor-stopping',
    };
  }

  if (sameLifecycleRegistration(active.key, owner.key)) {
    if (!sameBridgeGeneration(active.bridgeGeneration, owner.bridgeGeneration)) {
      return {
        kind: 'reject',
        owner,
        reason: 'registration-generation-conflict',
      };
    }
    return {
      kind: 'duplicate',
      owner,
      reason: 'same-lifecycle-stopped',
    };
  }

  if (sameBridgeGeneration(active.bridgeGeneration, owner.bridgeGeneration)) {
    return {
      kind: 'takeover',
      owner,
      mode: 'reuse',
      reason: 'bridge-generation-reused',
    };
  }

  return {
    kind: 'takeover',
    owner,
    mode: 'replace',
    reason: 'bridge-generation-changed',
  };
}

export function commitLifecycleAdoption(
  state: RegisterLifecycleState,
  decision: LifecycleAdoptionDecision,
) {
  if (decision.kind === 'duplicate' || decision.kind === 'reject') {
    return state.active;
  }

  state.nextGeneration = Math.max(state.nextGeneration + 1, decision.owner.key.generation + 1);

  if (decision.kind === 'defer') {
    state.pending = decision.owner;
    state.pendingMode = decision.mode;
    return state.active;
  }

  state.active = decision.owner;
  state.pending = undefined;
  state.pendingMode = undefined;
  state.retirement = undefined;
  state.resolveRetirement = undefined;
  return state.active;
}

export function beginLifecycleRetirement(
  state: RegisterLifecycleState,
  registryFingerprint: string,
  now: number,
  expectedGeneration?: number,
) {
  const active = state.active;
  if (
    !active ||
    active.key.registryFingerprint !== registryFingerprint ||
    (expectedGeneration !== undefined && active.key.generation !== expectedGeneration) ||
    (active.phase !== 'active' && active.phase !== 'registering')
  ) {
    state.staleCallbackSuppressions += 1;
    return null;
  }

  let resolveRetirement!: (outcome: LifecycleRetirementOutcome) => void;
  state.retirement = new Promise<LifecycleRetirementOutcome>((resolve) => {
    resolveRetirement = resolve;
  });
  state.resolveRetirement = resolveRetirement;
  active.phase = 'stopping';
  active.stopRequestedAt = now;
  return state.retirement;
}

export function settleLifecycleRetirement(
  state: RegisterLifecycleState,
  registryFingerprint: string,
  outcome: LifecycleRetirementOutcome,
  now: number,
  expectedGeneration?: number,
) {
  const active = state.active;
  if (
    !active ||
    active.key.registryFingerprint !== registryFingerprint ||
    (expectedGeneration !== undefined && active.key.generation !== expectedGeneration) ||
    active.phase !== 'stopping'
  ) {
    state.staleCallbackSuppressions += 1;
    return false;
  }

  const resolveRetirement = state.resolveRetirement;
  state.resolveRetirement = undefined;
  active.phase = outcome.ok ? 'stopped' : 'failed';
  active.stoppedAt = outcome.ok ? now : null;
  active.failure = outcome.ok ? null : outcome.error;
  resolveRetirement?.(outcome);
  return true;
}

export function activatePendingLifecycle(
  state: RegisterLifecycleState,
  registryFingerprint: string,
  now: number,
  expectedGeneration?: number,
) {
  const pending = state.pending;
  if (
    !pending ||
    pending.key.registryFingerprint !== registryFingerprint ||
    (expectedGeneration !== undefined && pending.key.generation !== expectedGeneration)
  ) {
    return null;
  }
  if (state.active?.phase !== 'stopped') {
    return null;
  }

  pending.phase = 'active';
  pending.startedAt = now;
  state.active = pending;
  state.pending = undefined;
  state.pendingMode = undefined;
  state.retirement = undefined;
  state.resolveRetirement = undefined;
  return state.active;
}

export function reactivateStoppedLifecycle(
  state: RegisterLifecycleState,
  registryFingerprint: string,
  now: number,
  expectedGeneration?: number,
) {
  const active = state.active;
  if (
    state.pending ||
    !active ||
    active.key.registryFingerprint !== registryFingerprint ||
    (expectedGeneration !== undefined && active.key.generation !== expectedGeneration) ||
    active.phase !== 'stopped'
  ) {
    return null;
  }
  active.phase = 'active';
  active.startedAt = now;
  active.stopRequestedAt = null;
  active.stoppedAt = null;
  active.failure = null;
  return active;
}

export function failLifecycle(
  state: RegisterLifecycleState,
  registryFingerprint: string,
  error: unknown,
  expectedGeneration?: number,
) {
  const active = state.active;
  if (
    !active ||
    active.key.registryFingerprint !== registryFingerprint ||
    (expectedGeneration !== undefined && active.key.generation !== expectedGeneration)
  ) {
    state.staleCallbackSuppressions += 1;
    return false;
  }
  if (active.phase !== 'active' && active.phase !== 'registering') {
    state.staleCallbackSuppressions += 1;
    return false;
  }
  active.phase = 'failed';
  active.stoppedAt = null;
  active.failure = error instanceof Error ? error.message : String(error);
  return true;
}

export function getActiveLifecycle(state: RegisterLifecycleState) {
  return state.active;
}

export function getPendingLifecycle(state: RegisterLifecycleState) {
  return state.pending;
}

export function isLifecycleRegistryActive(
  state: RegisterLifecycleState,
  registryFingerprint: string,
  expectedGeneration?: number,
) {
  return Boolean(
    state.active?.key.registryFingerprint === registryFingerprint &&
      (expectedGeneration === undefined || state.active.key.generation === expectedGeneration) &&
      (state.active.phase === 'active' || state.active.phase === 'registering'),
  );
}

export function isLifecycleRegistryStoppable(
  state: RegisterLifecycleState,
  registryFingerprint: string,
  expectedGeneration?: number,
) {
  const active = state.active;
  return Boolean(
    active?.key.registryFingerprint === registryFingerprint &&
      (expectedGeneration === undefined || active.key.generation === expectedGeneration) &&
      (active.phase === 'registering' || active.phase === 'active' || active.phase === 'stopping'),
  );
}

export function dumpLifecycleOwner(owner?: LifecycleOwner) {
  if (!owner) return null;
  return {
    generation: owner.key.generation,
    apiInstanceId: owner.key.apiInstanceId,
    registryFingerprint: owner.key.registryFingerprint,
    phase: owner.phase,
    moduleEpoch: owner.bridgeGeneration.moduleEpoch,
    bridgeFactoryId: owner.bridgeGeneration.bridgeFactoryId,
    pluginVersion: owner.bridgeGeneration.pluginVersion,
    startedAt: owner.startedAt,
    stopRequestedAt: owner.stopRequestedAt,
    stoppedAt: owner.stoppedAt,
    failure: owner.failure,
  };
}
