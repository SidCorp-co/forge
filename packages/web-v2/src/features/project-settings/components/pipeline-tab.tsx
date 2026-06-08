"use client";

// Project settings → Pipeline. Master `enabled` flag + the 8 auto-stage
// toggles. Reads/writes the FULL pipelineConfig (the PATCH schema requires
// `states`), so we round-trip the fetched object and only override the keys we
// surface — per-step runner/model overrides survive a save. When the
// `pipelineControl` flag is off, core 404s and we render an info empty-state.
import { useEffect, useState } from "react";
import { Banner, Button, Card, CardContent, EmptyState, ErrorState, Skeleton, Toggle } from "@/design";
import { formatApiError, formatPipelineConfigError } from "@/lib/api/error";
import { isFeatureOff, usePipelineConfig, useUpdatePipelineConfig } from "../hooks";
import {
  STEP_TOGGLE_KEYS,
  STEP_TOGGLE_LABELS,
  toggleEnabled,
  type PipelineConfig,
  type StepToggleKey,
} from "../types";

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <p className="fg-label text-fg">{label}</p>
        {hint && <p className="fg-caption text-muted">{hint}</p>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} aria-label={label} />
    </div>
  );
}

export function PipelineTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const cfgQ = usePipelineConfig(projectId);
  const update = useUpdatePipelineConfig(projectId);

  // Local working copy of the full config — preserves opaque keys on save.
  const [draft, setDraft] = useState<PipelineConfig | null>(null);
  useEffect(() => {
    if (cfgQ.data) setDraft(cfgQ.data.pipelineConfig);
  }, [cfgQ.data]);

  if (cfgQ.isLoading) {
    return (
      <Card>
        <CardContent>
          <div className="space-y-3">
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (cfgQ.isError) {
    if (isFeatureOff(cfgQ.error)) {
      return (
        <Card>
          <CardContent>
            <EmptyState
              title="Pipeline control is off"
              message="Per-project pipeline configuration isn't enabled on this deployment. Stages run on their built-in defaults."
              mascot={false}
            />
          </CardContent>
        </Card>
      );
    }
    return (
      <Card>
        <CardContent>
          <ErrorState message={formatApiError(cfgQ.error)} onRetry={() => cfgQ.refetch()} />
        </CardContent>
      </Card>
    );
  }

  if (!draft) return null;

  const server = cfgQ.data?.pipelineConfig ?? {};
  const masterEnabled = draft.enabled !== false;

  const dirty =
    (server.enabled !== false) !== masterEnabled ||
    STEP_TOGGLE_KEYS.some((k) => toggleEnabled(server[k]) !== toggleEnabled(draft[k]));

  function setToggle(key: StepToggleKey, value: boolean) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  return (
    <Card>
      <CardContent>
        <h2 className="fg-h3 mb-1">Pipeline</h2>
        <p className="fg-body-sm mb-4 text-muted">
          Control auto-dispatch per stage. Turning a stage off means an issue parks there until a
          human advances it.
        </p>

        <div className="divide-y divide-line">
          <ToggleRow
            label="Pipeline enabled"
            hint="Master switch — when off, no stage auto-dispatches."
            checked={masterEnabled}
            disabled={!canEdit}
            onChange={(v) => setDraft((d) => (d ? { ...d, enabled: v } : d))}
          />
          {STEP_TOGGLE_KEYS.map((k) => (
            <ToggleRow
              key={k}
              label={STEP_TOGGLE_LABELS[k].label}
              hint={STEP_TOGGLE_LABELS[k].hint}
              checked={toggleEnabled(draft[k])}
              disabled={!canEdit || !masterEnabled}
              onChange={(v) => setToggle(k, v)}
            />
          ))}
        </div>

        {canEdit && (
          <div className="mt-4 space-y-3">
            {update.isError && (
              <Banner tone="danger" onDismiss={() => update.reset()}>
                {formatPipelineConfigError(update.error)}
              </Banner>
            )}
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={!dirty}
              onClick={() => update.mutate(draft)}
              className="min-h-11"
            >
              Save pipeline config
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
