"use client";

// Project settings → Pipeline → "Concurrency".
//
// Sets `pipelineConfig.maxConcurrentIssues` — the per-project cap on how many
// issues run at once across the runner pool (core `dispatch-gates.ts`
// resolveProjectCap → the picker's L3 running_ids gate). Default 1 keeps the
// serial-per-project behaviour; raise it to parallelize INDEPENDENT issues
// (dependent ones stay serialized by the blocks/decomposes gates regardless).
//
// Save-island contract mirrors merge-states-section.tsx: take the full fetched
// config, edit only this slice, spread `...config` so sibling keys survive the
// shallow PATCH merge.

import { useEffect, useMemo, useState } from "react";
import { Banner, Button, Icon, Input } from "@/design";
import { formatPipelineConfigError } from "@/lib/api/error";
import { useUpdatePipelineConfig } from "../hooks";
import type { PipelineConfig } from "../types";

const DEFAULT_CAP = 1;
const MIN_CAP = 1;
const MAX_CAP = 20;

export function ConcurrencySection({
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

  const seeded = config.maxConcurrentIssues ?? DEFAULT_CAP;
  // Hold the raw input text so a user can clear the field mid-edit without it
  // snapping back; we validate on save.
  const [text, setText] = useState(String(seeded));
  useEffect(() => {
    setText(String(config.maxConcurrentIssues ?? DEFAULT_CAP));
  }, [config]);

  const parsed = Number(text);
  const valid =
    Number.isInteger(parsed) && parsed >= MIN_CAP && parsed <= MAX_CAP;
  const dirty = valid && parsed !== seeded;
  const showRangeError = useMemo(() => text.trim() !== "" && !valid, [text, valid]);

  function save() {
    if (!valid) return;
    const next: PipelineConfig = { ...config, maxConcurrentIssues: parsed };
    update.mutate(next);
  }

  const saveDisabled = !dirty || update.isPending;

  return (
    <div className="mt-6 border-t border-line pt-5">
      <h3 className="fg-label text-fg">Concurrency</h3>
      <p className="fg-body-sm mb-3 text-muted">
        How many issues this project runs at once across its runner pool. The
        default (<strong>1</strong>) processes issues serially. Raising it fans{" "}
        <strong>independent</strong> issues onto separate runners in parallel —
        dependent issues (linked by{" "}
        <code className="font-mono text-[12px]">blocks</code>/
        <code className="font-mono text-[12px]">decomposes</code>) stay
        serialized regardless. Each runner still handles one job at a time.
      </p>

      <div className="flex w-64 flex-col gap-1">
        <label className="fg-label text-fg" htmlFor="max-concurrent-issues">
          Max concurrent issues
        </label>
        {canEdit ? (
          <Input
            id="max-concurrent-issues"
            type="number"
            min={MIN_CAP}
            max={MAX_CAP}
            step={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <p className="fg-body-sm font-mono text-fg">{seeded}</p>
        )}
        <p className="fg-caption text-muted">Between {MIN_CAP} and {MAX_CAP}.</p>
      </div>

      {showRangeError && (
        <p
          className="fg-caption mt-3 flex items-start gap-1"
          style={{ color: "var(--amberw-600)" }}
        >
          <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
          <span>
            Enter a whole number between {MIN_CAP} and {MAX_CAP}.
          </span>
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
              Concurrency saved.
            </Banner>
          )}
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={saveDisabled}
            onClick={save}
            className="min-h-11"
          >
            Save concurrency
          </Button>
        </div>
      )}
    </div>
  );
}
