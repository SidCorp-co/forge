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
//
// ISS-232 Phase 4 — kept for the `availableRunners` derived output even
// after the `runnerFallback` field was removed: the per-step `runner`
// override picker still surfaces the runners registered on the project.
const DEFAULT_KNOWN_RUNNERS: string[] = ['claude-code'];

interface StepFormValue {
  enabled: boolean;
  runner?: string;
  model?: string;
}

/**
 * Editor model for `pipelineConfig.sessionGroups`. The partition is the
 * source of truth: `assignment` maps every stage to its group (or null when
 * Ungrouped), which makes the "at most one group per state" invariant
 * structural. `groupNames` keeps declared groups — including transiently
 * empty ones the user just created — in a stable display order. On save both
 * the top-level `sessionGroups` map AND each `states[x].sessionGroup` pointer
 * are derived from this (see `buildPipelinePatch`).
 */
export interface SessionGroupsFormState {
  groupNames: string[];
  assignment: Record<StageName, string | null>;
}

export interface PipelineConfigFormState {
  enabled: boolean;
  steps: Record<StepToggleKey, StepFormValue>;
  states: Record<StageName, StageConfig>;
  sessionGroups: SessionGroupsFormState;
  recoveryMaxAttempts: number;
  recoveryWindowHours: number;
  recoveryByKind: { transient: number; permanent: number; unknown: number };
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

function emptyAssignment(): Record<StageName, string | null> {
  return STAGE_NAMES.reduce(
    (acc, s) => {
      acc[s] = null;
      return acc;
    },
    {} as Record<StageName, string | null>,
  );
}

function defaultSessionGroupsForm(): SessionGroupsFormState {
  return { groupNames: [], assignment: emptyAssignment() };
}

/**
 * Rebuild the wire-shape `sessionGroups` map from the partition. Stages are
 * emitted in `STAGE_NAMES` order; empty groups are dropped (the backend Zod
 * schema rejects a group with an empty state array).
 */
export function buildSessionGroupsMap(
  sg: SessionGroupsFormState,
): Record<string, StageName[]> {
  const map: Record<string, StageName[]> = {};
  for (const stage of STAGE_NAMES) {
    const group = sg.assignment[stage];
    if (group && sg.groupNames.includes(group)) {
      (map[group] ??= []).push(stage);
    }
  }
  return map;
}

// ISS-232 Phase 3 flipped the backend default to `enabled: true`; mirror
// it here so the form's pre-hydrate state agrees with the eventual server
// response (avoids a flicker that briefly shows "Pipeline off").
const FALLBACK_DEFAULTS: PipelineConfigFormState = {
  enabled: true,
  steps: STEP_REGISTRY.reduce(
    (acc, s) => {
      acc[s.toggleKey] = { enabled: false };
      return acc;
    },
    {} as Record<StepToggleKey, StepFormValue>,
  ),
  states: defaultStatesForForm(),
  sessionGroups: defaultSessionGroupsForm(),
  recoveryMaxAttempts: 3,
  recoveryWindowHours: 24,
  recoveryByKind: { transient: 5, permanent: 0, unknown: 2 },
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
  // Hydrate the partition from the top-level `sessionGroups` map (the
  // canonical declaration). Unknown stage keys are ignored so a stale doc
  // can't crash the form.
  const serverGroups = (cfg.sessionGroups ?? {}) as Record<string, StageName[]>;
  const knownStages = new Set<string>(STAGE_NAMES);
  const assignment = emptyAssignment();
  for (const [group, stagesInGroup] of Object.entries(serverGroups)) {
    for (const stage of stagesInGroup) {
      if (knownStages.has(stage)) assignment[stage as StageName] = group;
    }
  }
  const sessionGroups: SessionGroupsFormState = {
    groupNames: Object.keys(serverGroups),
    assignment,
  };
  return {
    // ISS-232 Phase 3 — default flipped to `true` upstream; mirror that
    // here so a stored doc without an explicit `enabled` agrees with the
    // backend's `PIPELINE_CONFIG_DEFAULTS`.
    enabled: cfg.enabled ?? true,
    steps,
    states,
    sessionGroups,
    recoveryMaxAttempts: cfg.recoveryMaxAttempts ?? FALLBACK_DEFAULTS.recoveryMaxAttempts,
    recoveryWindowHours: cfg.recoveryWindowHours ?? FALLBACK_DEFAULTS.recoveryWindowHours,
    recoveryByKind: {
      transient: byKind.transient ?? FALLBACK_DEFAULTS.recoveryByKind.transient,
      permanent: byKind.permanent ?? FALLBACK_DEFAULTS.recoveryByKind.permanent,
      unknown: byKind.unknown ?? FALLBACK_DEFAULTS.recoveryByKind.unknown,
    },
  };
}

/**
 * Build the patch payload for `PATCH /pipeline-config` from the diff between
 * current form state and the server-fetched initial state. Only includes
 * fields the user actually touched.
 *
 * `rawStates` is the AUTHORITATIVE server `states` sub-tree (the full
 * objects, incl. per-stage `model`/`systemPrompt`/etc. the form does not
 * model). It is required when the session-group partition changed, because
 * the backend merge is shallow — a `states` patch replaces the whole key, so
 * we must resend every stage with its untouched fields preserved.
 */
function buildPipelinePatch(
  state: PipelineConfigFormState,
  initial: PipelineConfigFormState,
  rawStates: StatesConfig = {},
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

  // ISS-382 — the session-group partition writes BOTH representations: the
  // top-level `sessionGroups` map (wholesale-replaced) AND each per-state
  // `states[x].sessionGroup` pointer (the value the dispatcher actually
  // reads). When the partition changed we therefore rebuild the FULL states
  // map from the authoritative server config so no per-stage field is lost.
  const sessionGroupsDirty =
    JSON.stringify(state.sessionGroups) !== JSON.stringify(initial.sessionGroups);

  if (sessionGroupsDirty) {
    patch.sessionGroups = buildSessionGroupsMap(state.sessionGroups);
    const fullStates: StatesConfig = {};
    for (const stage of STAGE_NAMES) {
      const base: StageConfig = { ...(rawStates[stage] ?? {}) };
      // Apply the form's enabled/mode (parity with the touched-only path).
      base.enabled = state.states[stage].enabled;
      base.mode = state.states[stage].mode;
      const group = state.sessionGroups.assignment[stage];
      if (group) base.sessionGroup = group;
      else delete base.sessionGroup;
      fullStates[stage] = base;
    }
    patch.states = fullStates;
  } else {
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
  /** ISS-382 — session-group partition editing. */
  addSessionGroup: (name: string) => void;
  renameSessionGroup: (oldName: string, newName: string) => void;
  removeSessionGroup: (name: string) => void;
  /** Assign a stage to a group, or pass null to move it to Ungrouped. */
  assignStateToGroup: (stage: StageName, group: string | null) => void;
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
    return fromServer(query.data);
  }, [query.data]);

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

  // ISS-382 — session-group partition setters. addGroup/renameGroup no-op on
  // empty or duplicate names (the card surfaces the validation message); the
  // partition invariant — a stage in at most one group — is structural in
  // `assignment`, so assignStateToGroup simply overwrites the prior group.
  const addSessionGroup = (name: string) => {
    const trimmed = name.trim();
    setState((s) => {
      if (!trimmed || s.sessionGroups.groupNames.includes(trimmed)) return s;
      return {
        ...s,
        sessionGroups: {
          ...s.sessionGroups,
          groupNames: [...s.sessionGroups.groupNames, trimmed],
        },
      };
    });
  };

  const renameSessionGroup = (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    setState((s) => {
      if (!trimmed) return s;
      if (trimmed !== oldName && s.sessionGroups.groupNames.includes(trimmed)) return s;
      const groupNames = s.sessionGroups.groupNames.map((n) => (n === oldName ? trimmed : n));
      const assignment = { ...s.sessionGroups.assignment };
      for (const stage of STAGE_NAMES) {
        if (assignment[stage] === oldName) assignment[stage] = trimmed;
      }
      return { ...s, sessionGroups: { groupNames, assignment } };
    });
  };

  const removeSessionGroup = (name: string) => {
    setState((s) => {
      const assignment = { ...s.sessionGroups.assignment };
      for (const stage of STAGE_NAMES) {
        if (assignment[stage] === name) assignment[stage] = null;
      }
      return {
        ...s,
        sessionGroups: {
          groupNames: s.sessionGroups.groupNames.filter((n) => n !== name),
          assignment,
        },
      };
    });
  };

  const assignStateToGroup = (stage: StageName, group: string | null) => {
    setState((s) => ({
      ...s,
      sessionGroups: {
        ...s.sessionGroups,
        assignment: { ...s.sessionGroups.assignment, [stage]: group },
      },
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
    const rawStates = (query.data?.pipelineConfig.states ?? {}) as StatesConfig;
    const pipelinePatch: PipelineConfigPatch = buildPipelinePatch(state, initial, rawStates);
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
    addSessionGroup,
    renameSessionGroup,
    removeSessionGroup,
    assignStateToGroup,
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
