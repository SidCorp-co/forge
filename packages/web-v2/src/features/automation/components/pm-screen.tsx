"use client";

// Project-tier PM Agent surface — rendered as the "PM" tab inside the
// Automation shell (ISS-315). Real `/api/projects/:projectId/pm/*` data:
// cadence/config (read + owner-editable) plus the decision audit log timeline.
// Loading / empty / error states all render via kit primitives.
import { useEffect, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Divider,
  EmptyState,
  ErrorState,
  Field,
  Input,
  MonoTag,
  Pagination,
  Skeleton,
  Textarea,
  Toggle,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { usePmConfig, usePmDecisions, useUpdatePmConfig } from "../hooks";
import {
  PM_CRON_PRESETS,
  PM_MODEL_OPTIONS,
  PM_TRIGGER_LABELS,
  type PmConfig,
  type PmDecision,
  type PmEventTriggers,
} from "../types";

const DECISIONS_PAGE_SIZE = 25;

interface PmScreenProps {
  scope: { projectId: string; canManage: boolean };
}

function configIsDirty(a: PmConfig, b: PmConfig): boolean {
  return (
    a.enabled !== b.enabled ||
    a.cadenceCron !== b.cadenceCron ||
    a.customInstructions !== b.customInstructions ||
    a.modelOverride !== b.modelOverride ||
    a.maxRunsPerHour !== b.maxRunsPerHour ||
    JSON.stringify(a.eventTriggers) !== JSON.stringify(b.eventTriggers)
  );
}

/** Inline pill picker — shared by the cadence presets and model override. */
function PillPicker<T>({
  options,
  value,
  disabled,
  onSelect,
}: {
  options: { label: string; value: T }[];
  value: T;
  disabled?: boolean;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.label}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(o.value)}
            aria-pressed={active}
            className={
              active
                ? "rounded-md border border-transparent bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
                : "rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm text-muted hover:border-strong disabled:opacity-50"
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function PmConfigCard({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const configQ = usePmConfig(projectId);
  const update = useUpdatePmConfig(projectId);
  const [draft, setDraft] = useState<PmConfig | null>(null);

  useEffect(() => {
    if (configQ.data) setDraft(configQ.data);
  }, [configQ.data]);

  if (configQ.isLoading) {
    return <Skeleton className="h-80 w-full rounded-lg" />;
  }

  if (configQ.isError) {
    return (
      <ErrorState
        title="Couldn't load PM configuration"
        message={formatApiError(configQ.error)}
        onRetry={() => configQ.refetch()}
      />
    );
  }

  if (!draft || !configQ.data) return null;

  const saved = configQ.data;
  const dirty = configIsDirty(draft, saved);
  const editable = canManage && !update.isPending;

  function patch<K extends keyof PmConfig>(key: K, value: PmConfig[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  function patchTrigger(key: keyof PmEventTriggers, value: boolean) {
    setDraft((d) => (d ? { ...d, eventTriggers: { ...d.eventTriggers, [key]: value } } : d));
  }

  function handleSave() {
    if (!draft) return;
    update.mutate({
      enabled: draft.enabled,
      cadenceCron: draft.cadenceCron,
      eventTriggers: draft.eventTriggers,
      customInstructions: draft.customInstructions,
      modelOverride: draft.modelOverride,
      maxRunsPerHour: draft.maxRunsPerHour,
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>PM Agent configuration</CardTitle>
          <label className="inline-flex items-center gap-2">
            <span className="fg-body-sm text-muted">Enabled</span>
            <Toggle
              checked={draft.enabled}
              disabled={!editable}
              aria-label={draft.enabled ? "Disable PM Agent" : "Enable PM Agent"}
              onChange={(next) => patch("enabled", next)}
            />
          </label>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {!canManage && (
          <Banner tone="info">
            You have read-only access to PM settings. Owner or admin role is required to edit.
          </Banner>
        )}

        <Field label="Cadence" hint="How often the PM Agent runs on a timer.">
          <div className="space-y-2">
            <PillPicker
              options={PM_CRON_PRESETS}
              value={draft.cadenceCron}
              disabled={!editable}
              onSelect={(v) => patch("cadenceCron", v)}
            />
            <Input
              type="text"
              value={draft.cadenceCron ?? ""}
              disabled={!editable}
              placeholder="custom cron (e.g. */30 * * * *)"
              onChange={(e) => patch("cadenceCron", e.target.value || null)}
            />
          </div>
        </Field>

        <fieldset className="space-y-2">
          <legend className="fg-label">Event triggers</legend>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {(Object.keys(PM_TRIGGER_LABELS) as Array<keyof PmEventTriggers>).map((key) => (
              <Checkbox
                key={key}
                checked={draft.eventTriggers[key]}
                disabled={!editable}
                label={PM_TRIGGER_LABELS[key]}
                onChange={(next) => patchTrigger(key, next)}
              />
            ))}
          </div>
        </fieldset>

        <Field
          label="Custom instructions"
          hint="Optional Markdown appended to the PM agent's system prompt."
        >
          <Textarea
            rows={5}
            value={draft.customInstructions ?? ""}
            disabled={!editable}
            placeholder="e.g. Prioritise unblocking the release pipeline over backlog grooming."
            onChange={(e) => patch("customInstructions", e.target.value || null)}
          />
        </Field>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <Field label="Model override">
            <PillPicker
              options={PM_MODEL_OPTIONS}
              value={draft.modelOverride ?? ""}
              disabled={!editable}
              onSelect={(v) => patch("modelOverride", v || null)}
            />
          </Field>
          <Field label="Max runs / hour" hint="Rate cap for automatic runs (1–60).">
            <Input
              type="number"
              min={1}
              max={60}
              value={draft.maxRunsPerHour}
              disabled={!editable}
              onChange={(e) =>
                patch("maxRunsPerHour", Math.max(1, Math.min(60, Number(e.target.value) || 1)))
              }
            />
          </Field>
        </div>

        <Divider />
        <div className="flex items-center justify-end gap-3">
          {dirty && <span className="fg-caption text-subtle">Unsaved changes</span>}
          <Button
            variant="primary"
            disabled={!dirty || !editable}
            onClick={handleSave}
          >
            {update.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DecisionRow({ decision }: { decision: PmDecision }) {
  return (
    <li className="relative pl-6">
      <span
        aria-hidden
        className="absolute left-0 top-1.5 size-2.5 rounded-pill border border-line-strong bg-accent"
      />
      <div className="flex flex-wrap items-center gap-2">
        <MonoTag>{decision.cause}</MonoTag>
        {decision.confidence !== null && (
          <span className="fg-caption text-subtle">
            confidence {(decision.confidence * 100).toFixed(0)}%
          </span>
        )}
        {decision.modelTier && <Badge tone="cobalt">{decision.modelTier}</Badge>}
        <span className="fg-caption ml-auto text-subtle">{fmtTime(decision.createdAt)}</span>
      </div>
      <p className="fg-body-sm mt-1 text-fg">{decision.summary}</p>
    </li>
  );
}

function PmDecisionsCard({ projectId }: { projectId: string }) {
  const [page, setPage] = useState(1);
  const decisionsQ = usePmDecisions(projectId, page, DECISIONS_PAGE_SIZE);

  const items = decisionsQ.data?.items ?? [];
  const totalCount = decisionsQ.data?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalCount / DECISIONS_PAGE_SIZE));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Decision audit log</CardTitle>
          {totalCount > 0 && <Badge>{totalCount}</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {decisionsQ.isLoading && (
          <div className="space-y-2.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        )}

        {decisionsQ.isError && (
          <ErrorState
            title="Couldn't load decisions"
            message={formatApiError(decisionsQ.error)}
            onRetry={() => decisionsQ.refetch()}
          />
        )}

        {!decisionsQ.isLoading && !decisionsQ.isError && items.length === 0 && (
          <EmptyState
            title="No decisions yet"
            message="The PM Agent's decisions will appear here once it runs."
          />
        )}

        {!decisionsQ.isLoading && !decisionsQ.isError && items.length > 0 && (
          <>
            <ul className="space-y-4 border-l border-line pl-2">
              {items.map((d) => (
                <DecisionRow key={d.id} decision={d} />
              ))}
            </ul>
            {pageCount > 1 && (
              <div className="flex justify-end">
                <Pagination page={page} pageCount={pageCount} onChange={setPage} />
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function PmScreen({ scope }: PmScreenProps) {
  const { projectId, canManage } = scope;
  return (
    <div className="mx-auto w-full min-h-dvh max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-6">
        <h1 className="fg-h2">PM Agent</h1>
        <p className="fg-body-sm mt-1">
          Autonomous project management — cadence, triggers, and the decision audit log.
        </p>
      </header>
      <div className="space-y-6">
        <PmConfigCard projectId={projectId} canManage={canManage} />
        <PmDecisionsCard projectId={projectId} />
      </div>
    </div>
  );
}
