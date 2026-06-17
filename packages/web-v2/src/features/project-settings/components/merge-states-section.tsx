"use client";

// Project settings → Pipeline → "Merge points".
//
// `merged_at` (the column the `blocks`/`decomposes` dependency gate reads) is
// stamped ONLY when an issue transitions OUT of `mergeStates.baseBranch`
// (see core `issues/merged-at.ts`). If baseBranch points at a stage the pipeline
// never auto-leaves — a manual/disabled stage, or one whose auto-toggle is off,
// or a terminal rest state — `merged_at` never stamps and every dependent issue
// wedges silently. This config was previously invisible in the UI, which let the
// misconfig hide (anhome/sid-desk/dodgeprint-api). Surface it + warn.
//
// Save-island contract mirrors session-groups-section.tsx: take the full fetched
// config, edit only the `mergeStates` slice, spread `...config` so sibling keys
// survive the shallow PATCH merge.

import { useEffect, useMemo, useState } from "react";
import { Banner, Button, Icon, Select } from "@/design";
import { formatPipelineConfigError } from "@/lib/api/error";
import { useUpdatePipelineConfig } from "../hooks";
import {
  STEP_TOGGLE_KEYS,
  STEP_TOGGLE_LABELS,
  type PipelineConfig,
} from "../types";

// Realistic merge-completion states (where a skill merges the ISS-* branch into
// the base branch). `released` is the trunk-based default.
const MERGE_STATE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "developed", label: "developed (after Code/Review — skill-driven merge)" },
  { value: "testing", label: "testing (Test gate — merge + verify)" },
  { value: "tested", label: "tested" },
  { value: "pass", label: "pass" },
  { value: "staging", label: "staging" },
  { value: "released", label: "released (trunk-based default)" },
];

const DEFAULT_BASE = "released";
const DEFAULT_PROD = "released";

// stage (issueStatus) → its auto-toggle key (reverse of STEP_TOGGLE_LABELS).
const TOGGLE_BY_STAGE = new Map<string, (typeof STEP_TOGGLE_KEYS)[number]>(
  STEP_TOGGLE_KEYS.map((k) => [STEP_TOGGLE_LABELS[k].stage, k]),
);

function asStates(config: PipelineConfig): Record<string, Record<string, unknown>> {
  const s = config.states;
  return s && typeof s === "object" ? (s as Record<string, Record<string, unknown>>) : {};
}

/**
 * Client mirror of core's `computeMergeStateParkWarning`: flag a baseBranch the
 * pipeline can't auto-leave. Returns the advisory text, or null when fine.
 * (Can't detect a no-op skill on an enabled+auto stage — same limit as core.)
 */
function parkWarning(config: PipelineConfig, baseBranch: string): string | null {
  const sc = asStates(config)[baseBranch];
  if (sc && (sc as { mode?: string }).mode === "manual") {
    return `'${baseBranch}' is a manual stage — the pipeline won't auto-leave it, so merged_at never stamps and blocks/decomposes dependents will wedge.`;
  }
  const toggle = TOGGLE_BY_STAGE.get(baseBranch);
  if (toggle) {
    const raw = config[toggle];
    const off =
      raw === false || (raw != null && typeof raw === "object" && (raw as { enabled?: boolean }).enabled === false);
    if (off) {
      return `'${baseBranch}' maps to a step whose auto-toggle (${toggle}) is OFF — that stage never advances, so merged_at never stamps and blocks/decomposes dependents will wedge.`;
    }
  }
  return null;
}

export function MergeStatesSection({
  projectId,
  config,
  canEdit,
}: {
  projectId: string;
  /** The full server-fetched pipelineConfig (round-tripped on save). */
  config: PipelineConfig;
  canEdit: boolean;
}) {
  const update = useUpdatePipelineConfig(projectId);

  const seededBase = config.mergeStates?.baseBranch ?? DEFAULT_BASE;
  const seededProd = config.mergeStates?.productionBranch ?? DEFAULT_PROD;

  const [base, setBase] = useState(seededBase);
  const [prod, setProd] = useState(seededProd);
  useEffect(() => {
    setBase(config.mergeStates?.baseBranch ?? DEFAULT_BASE);
    setProd(config.mergeStates?.productionBranch ?? DEFAULT_PROD);
  }, [config]);

  const dirty = base !== seededBase || prod !== seededProd;
  const warning = useMemo(() => parkWarning(config, base), [config, base]);

  // Ensure the stored value is always selectable even if it's outside the
  // curated list (e.g. a legacy `approved`).
  const baseOptions = useMemo(() => {
    const opts = [...MERGE_STATE_OPTIONS];
    if (!opts.some((o) => o.value === base)) opts.unshift({ value: base, label: base });
    return opts;
  }, [base]);
  const prodOptions = useMemo(() => {
    const opts = [...MERGE_STATE_OPTIONS];
    if (!opts.some((o) => o.value === prod)) opts.unshift({ value: prod, label: prod });
    return opts;
  }, [prod]);

  function save() {
    const next: PipelineConfig = {
      ...config,
      mergeStates: { baseBranch: base, productionBranch: prod },
    };
    update.mutate(next);
  }

  const saveDisabled = !dirty || update.isPending;

  return (
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="fg-label text-fg">Merge points</h3>
      <p className="fg-body-sm mb-3 text-muted">
        When an issue leaves the <strong>base merge state</strong>, Forge stamps{" "}
        <code className="font-mono text-[12px]">merged_at</code> — which is what unblocks any{" "}
        <code className="font-mono text-[12px]">blocks</code>/<code className="font-mono text-[12px]">decomposes</code>{" "}
        dependents. Point it at the stage where the merge actually completes. If it points at a stage
        the pipeline never auto-leaves (manual, disabled, or a rest state), dependents wedge silently.
      </p>

      <div className="flex flex-wrap gap-4">
        <div className="flex w-64 flex-col gap-1">
          <label className="fg-label text-fg">Base merge state</label>
          {canEdit ? (
            <Select options={baseOptions} value={base} onChange={(v) => setBase(v)} />
          ) : (
            <p className="fg-body-sm font-mono text-fg">{base}</p>
          )}
          <p className="fg-caption text-muted">Exit of this state stamps merged_at.</p>
        </div>
        <div className="flex w-64 flex-col gap-1">
          <label className="fg-label text-fg">Production merge state</label>
          {canEdit ? (
            <Select options={prodOptions} value={prod} onChange={(v) => setProd(v)} />
          ) : (
            <p className="fg-body-sm font-mono text-fg">{prod}</p>
          )}
          <p className="fg-caption text-muted">Production-branch merge marker (v2: usually same).</p>
        </div>
      </div>

      {warning && (
        <p className="fg-caption mt-3 flex items-start gap-1" style={{ color: "var(--amberw-600)" }}>
          <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
          <span>{warning}</span>
        </p>
      )}

      {canEdit && (
        <div className="mt-3 space-y-3">
          {update.isError && (
            <Banner tone="danger" onDismiss={() => update.reset()}>
              {formatPipelineConfigError(update.error)}
            </Banner>
          )}
          {update.isSuccess && !dirty && (
            <Banner tone="success" onDismiss={() => update.reset()}>
              Merge points saved.
            </Banner>
          )}
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={saveDisabled}
            onClick={save}
            className="min-h-11"
          >
            Save merge points
          </Button>
        </div>
      )}
    </div>
  );
}
