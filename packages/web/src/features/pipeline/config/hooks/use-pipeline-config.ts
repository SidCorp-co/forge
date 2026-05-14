'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api/client';
import { pipelineConfigApi } from '../api';
import type {
  PipelineConfig,
  PipelineConfigPatch,
  PipelineConfigResponse,
  RecoveryByKind,
  StageConfig,
  StageName,
  StatesConfig,
  StepToggleValue,
} from '../types';
import {
  isStepEnabled,
  getStepRunner,
  getStepModel,
  buildStepToggle,
  STAGE_NAMES,
} from '../types';
import { STEP_REGISTRY, type StepToggleKey } from '../step-registry';

const pipelineConfigKey = (projectId: string | undefined) =>
  ['project', projectId, 'pipeline-config'] as const;

// Module-level so the default-arg path on `usePipelineConfig` keeps the same
// array reference across renders. A fresh `['claude-code']` literal would
// otherwise invalidate the `initial` useMemo every render, refire the
// hydrate useEffect, and silently reset user edits (e.g. Skills tab
// stage-enabled checkbox clicks didn't persist).
const DEFAULT_KNOWN_RUNNERS: string[] = ['claude-code'];

interface StepFormValue {
  enabled: boolean;
  runner?: string;
  model?: string;
}

export interface PipelineConfigFormState {
  enabled: boolean;
  steps: Record<StepToggleKey, StepFormValue>;
  states: Record<StageName, StageConfig>;
  recoveryMaxAttempts: number;
  recoveryWindowHours: number;
  recoveryByKind: { transient: number; permanent: number; unknown: number };
  runnerFallback: string[];
}

function defaultStatesForForm(): Record<StageName, StageConfig> {
  return STAGE_NAMES.reduce(
    (acc, s) => {
      acc[s] = { enabled: true, mode: 'auto' };
      return acc;
    },
    {} as Record<StageName, StageConfig>,
  );
}

const FALLBACK_DEFAULTS: PipelineConfigFormState = {
  enabled: false,
  steps: STEP_REGISTRY.reduce(
    (acc, s) => {
      acc[s.toggleKey] = { enabled: false };
      return acc;
    },
    {} as Record<StepToggleKey, StepFormValue>,
  ),
  states: defaultStatesForForm(),
  recoveryMaxAttempts: 3,
  recoveryWindowHours: 24,
  recoveryByKind: { transient: 5, permanent: 0, unknown: 2 },
  runnerFallback: ['claude-code'],
};

function fromServer(data: PipelineConfigResponse): PipelineConfigFormState {
  const cfg = data.pipelineConfig;
  const steps = STEP_REGISTRY.reduce(
    (acc, s) => {
      const v = cfg[s.toggleKey] as StepToggleValue | undefined;
      acc[s.toggleKey] = {
        enabled: isStepEnabled(v),
        runner: getStepRunner(v),
        model: getStepModel(v),
      };
      return acc;
    },
    {} as Record<StepToggleKey, StepFormValue>,
  );
  const byKind = (cfg.recoveryByFailureKind ?? {}) as RecoveryByKind;
  const serverStates = (cfg.states ?? {}) as StatesConfig;
  const states = STAGE_NAMES.reduce(
    (acc, s) => {
      const sc = serverStates[s];
      acc[s] = {
        enabled: sc?.enabled ?? true,
        mode: sc?.mode ?? 'auto',
      };
      return acc;
    },
    {} as Record<StageName, StageConfig>,
  );
  return {
    enabled: cfg.enabled ?? false,
    steps,
    states,
    recoveryMaxAttempts: cfg.recoveryMaxAttempts ?? FALLBACK_DEFAULTS.recoveryMaxAttempts,
    recoveryWindowHours: cfg.recoveryWindowHours ?? FALLBACK_DEFAULTS.recoveryWindowHours,
    recoveryByKind: {
      transient: byKind.transient ?? FALLBACK_DEFAULTS.recoveryByKind.transient,
      permanent: byKind.permanent ?? FALLBACK_DEFAULTS.recoveryByKind.permanent,
      unknown: byKind.unknown ?? FALLBACK_DEFAULTS.recoveryByKind.unknown,
    },
    runnerFallback:
      Array.isArray(data.runnerFallback) && data.runnerFallback.length > 0
        ? data.runnerFallback
        : FALLBACK_DEFAULTS.runnerFallback,
  };
}

/**
 * Build the patch payload for `PATCH /pipeline-config` from the diff between
 * current form state and the server-fetched initial state. Only includes
 * fields the user actually touched.
 */
function buildPipelinePatch(
  state: PipelineConfigFormState,
  initial: PipelineConfigFormState,
): PipelineConfigPatch {
  const patch: PipelineConfigPatch = {};
  if (state.enabled !== initial.enabled) patch.enabled = state.enabled;

  for (const def of STEP_REGISTRY) {
    const cur = state.steps[def.toggleKey];
    const orig = initial.steps[def.toggleKey];
    if (cur.enabled !== orig.enabled || cur.runner !== orig.runner || cur.model !== orig.model) {
      patch[def.toggleKey] = buildStepToggle(cur.enabled, cur.runner, cur.model);
    }
  }

  if (state.recoveryMaxAttempts !== initial.recoveryMaxAttempts)
    patch.recoveryMaxAttempts = state.recoveryMaxAttempts;
  if (state.recoveryWindowHours !== initial.recoveryWindowHours)
    patch.recoveryWindowHours = state.recoveryWindowHours;

  const k = state.recoveryByKind;
  const ko = initial.recoveryByKind;
  if (k.transient !== ko.transient || k.permanent !== ko.permanent || k.unknown !== ko.unknown) {
    patch.recoveryByFailureKind = {
      transient: k.transient,
      permanent: k.permanent,
      unknown: k.unknown,
    };
  }

  // ISS-109 — diff per-stage states; only emit the stages the user touched
  // so the backend deep-merge preserves untouched stages on the on-disk doc.
  const statesPatch: StatesConfig = {};
  for (const stage of STAGE_NAMES) {
    const cur = state.states[stage];
    const orig = initial.states[stage];
    if (cur.enabled !== orig.enabled || cur.mode !== orig.mode) {
      statesPatch[stage] = { enabled: cur.enabled, mode: cur.mode };
    }
  }
  if (Object.keys(statesPatch).length > 0) {
    patch.states = statesPatch;
  }

  return patch;
}

export interface UsePipelineConfigResult {
  state: PipelineConfigFormState;
  /** Set a top-level field. */
  setField: <K extends keyof PipelineConfigFormState>(
    key: K,
    value: PipelineConfigFormState[K],
  ) => void;
  /** Toggle / change a single pipeline step. */
  setStep: (key: StepToggleKey, value: StepFormValue) => void;
  /** Update a single recovery-by-kind cap. */
  setRecoveryByKind: (kind: keyof RecoveryByKind, value: number) => void;
  /** Update a single stage's enabled/mode (ISS-109). */
  setStage: (name: StageName, value: Partial<StageConfig>) => void;
  isLoading: boolean;
  isSaving: boolean;
  isDirty: boolean;
  isError: boolean;
  /** True when the backend signals the feature flag is disabled. */
  flagDisabled: boolean;
  error: unknown;
  save: () => Promise<void>;
  reset: () => void;
  /** Available runner types known to the project, derived from registered runners. */
  availableRunners: string[];
}

export function usePipelineConfig(
  projectId: string | undefined,
  /** Pre-known runner types (from project.runners) — passed in to avoid a 2nd fetch. */
  knownRunners: string[] = DEFAULT_KNOWN_RUNNERS,
): UsePipelineConfigResult {
  const qc = useQueryClient();

  const query = useQuery<PipelineConfigResponse, ApiError>({
    queryKey: pipelineConfigKey(projectId),
    queryFn: () => pipelineConfigApi.get(projectId as string),
    enabled: !!projectId,
    retry: (count, err) => {
      // Don't retry on flag-off (404 with FEATURE_OFF) — we render a banner.
      if (err instanceof ApiError && err.status === 404) return false;
      return count < 2;
    },
  });

  const initial = useMemo<PipelineConfigFormState>(() => {
    if (!query.data) return FALLBACK_DEFAULTS;
    const fromServerState = fromServer(query.data);
    // If the project has registered runners, default the chain to all
    // known types when none stored.
    if (
      knownRunners.length > 0 &&
      JSON.stringify(fromServerState.runnerFallback) ===
        JSON.stringify(FALLBACK_DEFAULTS.runnerFallback)
    ) {
      return { ...fromServerState, runnerFallback: knownRunners.slice() };
    }
    return fromServerState;
  }, [query.data, knownRunners]);

  const [state, setState] = useState<PipelineConfigFormState>(FALLBACK_DEFAULTS);

  // Hydrate once when the query resolves or the project changes.
  useEffect(() => {
    setState(initial);
  }, [initial]);

  const setField = <K extends keyof PipelineConfigFormState>(
    key: K,
    value: PipelineConfigFormState[K],
  ) => {
    setState((s) => ({ ...s, [key]: value }));
  };

  const setStep = (key: StepToggleKey, value: StepFormValue) => {
    setState((s) => ({ ...s, steps: { ...s.steps, [key]: value } }));
  };

  const setRecoveryByKind = (kind: keyof RecoveryByKind, value: number) => {
    setState((s) => ({
      ...s,
      recoveryByKind: { ...s.recoveryByKind, [kind]: value },
    }));
  };

  const setStage = (name: StageName, value: Partial<StageConfig>) => {
    setState((s) => ({
      ...s,
      states: { ...s.states, [name]: { ...s.states[name], ...value } },
    }));
  };

  const reset = () => setState(initial);

  const isDirty = useMemo(() => {
    return JSON.stringify(state) !== JSON.stringify(initial);
  }, [state, initial]);

  const flagDisabled =
    query.isError &&
    query.error instanceof ApiError &&
    query.error.status === 404 &&
    query.error.code === 'FEATURE_OFF';

  const patchPipeline = useMutation({
    mutationFn: (patch: PipelineConfigPatch) =>
      pipelineConfigApi.patch(projectId as string, patch),
  });

  const save = async () => {
    if (!projectId) return;
    const pipelinePatch: PipelineConfigPatch = buildPipelinePatch(state, initial);
    const runnerFallbackChanged =
      JSON.stringify(state.runnerFallback) !== JSON.stringify(initial.runnerFallback);
    if (runnerFallbackChanged) {
      pipelinePatch.runnerFallback = state.runnerFallback;
    }

    if (Object.keys(pipelinePatch).length === 0) return;
    await patchPipeline.mutateAsync(pipelinePatch);
    await Promise.all([
      qc.invalidateQueries({ queryKey: pipelineConfigKey(projectId) }),
      qc.invalidateQueries({ queryKey: ['project', projectId] }),
    ]);
  };

  return {
    state,
    setField,
    setStep,
    setRecoveryByKind,
    setStage,
    isLoading: query.isLoading,
    isSaving: patchPipeline.isPending,
    isDirty,
    isError: query.isError || patchPipeline.isError,
    flagDisabled,
    error: query.error ?? patchPipeline.error,
    save,
    reset,
    availableRunners:
      knownRunners.length > 0 ? Array.from(new Set(knownRunners)) : ['claude-code'],
  };
}

// Re-export a couple of helpers for tests.
export type { StepFormValue };
export { fromServer as __fromServer, buildPipelinePatch as __buildPipelinePatch };
export type { PipelineConfig, PipelineConfigPatch };
