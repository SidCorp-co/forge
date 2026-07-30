"use client";

// Awaiting-release card — pipeline runs parked at the manual `tested` gate:
// done and verified, just waiting on a human to advance tested→released. These
// are NOT live/executing work (see `LiveRunsCard`), so they get their own
// list with a calm "Verified" chip instead of the pulsing "running" one, and a
// collapsed default so a large backlog can't push the rest of the dashboard
// (Runners, Upcoming schedules) below the fold.
//
// ISS-764 Batch Release: rows with a resolvable issue get a checkbox;
// selecting ≥1 reveals a "Release {n}" action that creates a batch release
// via the batch endpoint (single deploy + single changelog + simultaneous
// close). Previously this was a per-issue tested→released fan-out via
// `useBulkUpdateIssues`; replaced with `useBatchRelease` so the whole set
// deploys and closes atomically in one agent session.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent, Checkbox, Icon, StatusChip } from "@/design";
import { useBatchRelease } from "@/features/issues/hooks";
import { BatchReleaseDialog, type BatchReleaseIssue } from "@/features/issues/components/batch-release-dialog";
import { formatUsd } from "@/features/pipeline/derive";
import type { PipelineRunListItem } from "@/features/pipeline/types";

const COLLAPSED_LIMIT = 5;

/** Oldest-parked first — the longest a run has sat awaiting release is the
 *  clearest signal of what to triage first. */
function byOldestFirst(runs: PipelineRunListItem[]): PipelineRunListItem[] {
  return [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

export function AwaitingReleaseCard({
  runs,
  slug,
  projectId,
}: {
  runs: PipelineRunListItem[];
  slug: string;
  projectId: string;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const batch = useBatchRelease(projectId);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchDialogOpen, setBatchDialogOpen] = useState(false);
  const sorted = byOldestFirst(runs);
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = sorted.length - visible.length;
  const selectableVisible = visible.filter((run) => run.issueId != null);
  const selectedCount = selected.size;
  const allVisibleSelected =
    selectableVisible.length > 0 && selectableVisible.every((run) => selected.has(run.issueId as string));

  // Synthesize minimal BatchReleaseIssue shape from the run list item fields.
  const selectedIssues: BatchReleaseIssue[] = selectableVisible
    .filter((run) => run.issueId != null && selected.has(run.issueId as string))
    .map((run) => ({
      id: run.issueId as string,
      displayId: run.issueRef ?? (run.issueId as string),
      title: run.issueTitle ?? "",
    }));

  const open = (run: PipelineRunListItem) => {
    router.push(run.issueId ? `/projects/${slug}/issues/${run.issueId}` : `/projects/${slug}/pipeline`);
  };

  const toggle = (issueId: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(issueId);
      else next.delete(issueId);
      return next;
    });
  };

  const toggleAllVisible = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const run of selectableVisible) {
        if (checked) next.add(run.issueId as string);
        else next.delete(run.issueId as string);
      }
      return next;
    });
  };

  return (
    <>
    <Card className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon name="check" size={16} className="text-subtle" />
          <h3 className="fg-h3">Awaiting release</h3>
        </div>
        {runs.length > 0 && <span className="fg-caption font-mono text-subtle">{runs.length}</span>}
      </div>
      <CardContent className="flex-1">
        {runs.length === 0 ? (
          <p className="fg-body-sm py-6 text-center text-muted">Nothing waiting on a release decision.</p>
        ) : (
          <>
            {selectableVisible.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Checkbox
                  checked={allVisibleSelected}
                  indeterminate={selectedCount > 0 && !allVisibleSelected}
                  onChange={toggleAllVisible}
                  ariaLabel={allVisibleSelected ? "Clear selection" : "Select all"}
                  label={allVisibleSelected ? "Clear" : "Select all"}
                />
                <Button
                  variant="primary"
                  size="sm"
                  className="ml-auto"
                  disabled={selectedCount === 0}
                  loading={batch.isPending}
                  onClick={() => setBatchDialogOpen(true)}
                >
                  {selectedCount > 0 ? `Release ${selectedCount}` : "Release"}
                </Button>
              </div>
            )}
            <ul className="flex flex-col gap-2">
              {visible.map((run) => (
                <li
                  key={run.id}
                  className="flex items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2 transition-colors hover:bg-hover"
                >
                  {run.issueId && (
                    <Checkbox
                      checked={selected.has(run.issueId)}
                      onChange={(checked) => toggle(run.issueId as string, checked)}
                      ariaLabel={`Select ${run.issueRef ?? "run"}`}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => open(run)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                  >
                    <StatusChip status="passed" domain="session" size="sm" />
                    <span className="fg-body-sm min-w-0 flex-1 truncate text-muted">
                      {run.issueRef ? (
                        <>
                          <span className="font-mono text-fg">{run.issueRef}</span>
                          {run.issueTitle ? ` ${run.issueTitle}` : ""}
                        </>
                      ) : (
                        "Run"
                      )}
                    </span>
                    <span className="font-mono text-sm font-semibold tabular-nums text-fg">
                      {formatUsd(run.cost?.estimatedCost)}
                    </span>
                    <Icon name="chevronRight" size={14} className="flex-none text-subtle" />
                  </button>
                </li>
              ))}
            </ul>
            {hiddenCount > 0 && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="fg-body-sm mt-2 w-full rounded-md py-1.5 text-center text-subtle transition-colors hover:bg-hover hover:text-fg"
              >
                Show {hiddenCount} more
              </button>
            )}
          </>
        )}
      </CardContent>
    </Card>
    <BatchReleaseDialog
      projectId={projectId}
      selectedIssues={selectedIssues}
      open={batchDialogOpen}
      onClose={() => setBatchDialogOpen(false)}
      onSuccess={() => {
        setSelected(new Set());
        qc.invalidateQueries({ queryKey: ["pipeline-runs"] });
      }}
    />
    </>
  );
}
