"use client";

// Project settings → Pipeline → "Per-job context".
//
// Edits `agentConfig.stateContext` — a model override and a spend budget per
// jobType, reached through the scoped `stateContext` field on
// `PATCH /api/projects/:id` (there is no dedicated route). Reads the same
// `GET /api/projects/:id` the rest of Settings already calls, deduped by
// `useProject` on the `['project', id]` query key.
//
// Plugins, the other half of `agentConfig`, are owned by PluginsSection above.

import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useProject } from "@/features/projects/hooks";
import { useUpdateStateContext } from "../hooks";
import {
  BUDGET_PER_MONTH_MAX,
  BUDGET_PER_RUN_MAX,
  STATE_CONTEXT_JOB_TYPES,
  validateBudget,
  type BudgetAction,
  type ProjectAgentConfig,
  type StateContextEntry,
} from "../types";

function asAgentConfig(raw: unknown): ProjectAgentConfig {
  return raw && typeof raw === "object" ? (raw as ProjectAgentConfig) : {};
}

type Draft = Record<string, StateContextEntry>;

function numOrUndefined(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function entryErrors(entry: StateContextEntry): string[] {
  return validateBudget(entry.budget ?? {});
}

function EntryRow({
  jobType,
  entry,
  canEdit,
  onPatch,
  onRemove,
}: {
  jobType: string;
  entry: StateContextEntry;
  canEdit: boolean;
  onPatch: (patch: StateContextEntry) => void;
  onRemove: () => void;
}) {
  const budget = entry.budget ?? {};
  const errors = entryErrors(entry);
  const hasBudget = budget.perRunUsd != null || budget.perMonthUsd != null || budget.action != null;

  // cm:guard every patch spreads the stored ENTRY, not just the two fields drawn here. The server replaces a jobType's entry whole (`mergeStateContext`), so a patch built from the form alone deletes `blocks` and anything a later schema adds.
  const patchBudget = (b: Partial<typeof budget>) =>
    onPatch({ ...entry, budget: { ...budget, ...b } });

  // cm:guard turning the cap ON seeds the ACTION only, never zeros — a `perRunUsd: 0` saved unedited is a real cap of nothing, so an operator who ticked a box would have shipped a dispatch block. The incomplete budget fails validateBudget, and that is what holds Save until real numbers are typed.
  const toggleBudget = (on: boolean) =>
    onPatch({ ...entry, budget: on ? { action: "warn" } : undefined });

  return (
    <li className="rounded-md border border-line bg-surface p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="fg-label font-mono text-fg">{jobType}</p>
        {canEdit && (
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Model override" hint="Blank uses the stage's own model.">
          <Input
            value={entry.modelOverride ?? ""}
            onChange={(e) => onPatch({ ...entry, modelOverride: e.target.value || null })}
            disabled={!canEdit}
            placeholder="claude-opus-5"
          />
        </Field>
        <div className="flex items-end pb-1">
          <Checkbox
            checked={hasBudget}
            onChange={toggleBudget}
            disabled={!canEdit}
            label="Cap spend for this job type"
          />
        </div>
      </div>

      {hasBudget && (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Per run (USD)" hint={`0–${BUDGET_PER_RUN_MAX}`}>
            <Input
              type="number"
              value={budget.perRunUsd ?? ""}
              onChange={(e) => patchBudget({ perRunUsd: numOrUndefined(e.target.value) })}
              disabled={!canEdit}
            />
          </Field>
          <Field label="Per month (USD)" hint={`0–${BUDGET_PER_MONTH_MAX}`}>
            <Input
              type="number"
              value={budget.perMonthUsd ?? ""}
              onChange={(e) => patchBudget({ perMonthUsd: numOrUndefined(e.target.value) })}
              disabled={!canEdit}
            />
          </Field>
          <Field label="At the monthly cap" hint="Warn keeps dispatching; pause stops it.">
            <Select
              options={[
                { value: "warn", label: "Warn only" },
                { value: "pause", label: "Pause dispatch" },
              ]}
              value={budget.action ?? ""}
              onChange={(v) => patchBudget({ action: v as BudgetAction })}
              aria-label="At the monthly cap"
              disabled={!canEdit}
            />
          </Field>
        </div>
      )}

      {errors.length > 0 && (
        <p className="fg-caption mt-2" style={{ color: "var(--red-600)" }}>
          {errors.join(" ")}
        </p>
      )}
    </li>
  );
}

export function AgentConfigSection({
  projectId,
  canEdit,
}: {
  projectId: string;
  canEdit: boolean;
}) {
  const projectQ = useProject(projectId);
  const update = useUpdateStateContext(projectId);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [adding, setAdding] = useState("");
  useEffect(() => {
    if (!projectQ.data) return;
    setDraft({ ...(asAgentConfig(projectQ.data.agentConfig).stateContext ?? {}) });
  }, [projectQ.data]);

  const heading = (
    <div>
      <h3 className="fg-label text-fg">Per-job context</h3>
      <p className="fg-caption mt-0.5 text-muted">
        A model and a spend cap per kind of job, applied on top of the stage config above.
      </p>
    </div>
  );

  // cm:guard the error branch sits BEFORE the loading one — `draft` seeds from `projectQ.data`, so on a failed fetch it stays null and a skeleton rendered first never resolves, which is the dead end §2 of the UX contract forbids.
  if (projectQ.isError) {
    return (
      <div className="mt-6 border-t border-line pt-5">
        {heading}
        <div className="mt-3">
          <ErrorState message={formatApiError(projectQ.error)} onRetry={() => projectQ.refetch()} />
        </div>
      </div>
    );
  }

  if (projectQ.isLoading || !draft) {
    return (
      <div className="mt-6 border-t border-line pt-5">
        {heading}
        <div className="mt-3 space-y-2">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-2/3 rounded-md" />
        </div>
      </div>
    );
  }

  const stored = asAgentConfig(projectQ.data?.agentConfig).stateContext ?? {};
  const entries = Object.entries(draft);
  const unused = STATE_CONTEXT_JOB_TYPES.filter((t) => !(t in draft));
  const firstError = entries.flatMap(([, e]) => entryErrors(e))[0] ?? null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);

  // cm:guard a REMOVED jobType must be sent as an explicit `null` — the server merges per key, so simply dropping it from the patch leaves the stored entry in place and the screen then disagrees with the database.
  function save() {
    const patch: Record<string, StateContextEntry | null> = { ...draft };
    for (const jobType of Object.keys(stored)) {
      if (!(jobType in (draft ?? {}))) patch[jobType] = null;
    }
    update.mutate(patch);
  }

  return (
    <div className="mt-6 border-t border-line pt-5">
      {heading}

      {entries.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="No per-job context"
            message="Every job runs on its stage's model with no spend cap. Add a job type to change that for one kind of work."
            mascot
            action={
              canEdit && unused.length > 0
                ? {
                    label: `Add ${unused[0]}`,
                    onClick: () => setDraft((d) => ({ ...(d ?? {}), [unused[0]]: {} })),
                  }
                : undefined
            }
          />
        </div>
      ) : (
        <ul className="mt-3 space-y-3">
          {entries.map(([jobType, entry]) => (
            <EntryRow
              key={jobType}
              jobType={jobType}
              entry={entry}
              canEdit={canEdit}
              onPatch={(next) => setDraft((d) => ({ ...(d ?? {}), [jobType]: next }))}
              onRemove={() =>
                setDraft((d) => {
                  const n = { ...(d ?? {}) };
                  delete n[jobType];
                  return n;
                })
              }
            />
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="mt-3 space-y-3">
          {unused.length > 0 && entries.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select
                options={unused.map((t) => ({ value: t, label: t }))}
                value={adding}
                onChange={setAdding}
                placeholder="Add a job type…"
                aria-label="Add a job type"
                className="sm:w-64"
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={!adding}
                onClick={() => {
                  setDraft((d) => ({ ...(d ?? {}), [adding]: {} }));
                  setAdding("");
                }}
              >
                Add
              </Button>
            </div>
          )}

          {firstError && (
            <Banner tone="attention">Fix the budget flagged above before saving.</Banner>
          )}

          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!dirty || firstError !== null}
            onClick={save}
            className="min-h-11"
          >
            Save per-job context
          </Button>
        </div>
      )}
    </div>
  );
}
