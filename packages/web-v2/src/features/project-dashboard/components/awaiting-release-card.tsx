"use client";

// Awaiting-release card — pipeline runs parked at the manual `tested` gate:
// done and verified, just waiting on a human to advance tested→released. These
// are NOT live/executing work (see `LiveRunsCard`), so they get their own
// list with a calm "Verified" chip instead of the pulsing "running" one, and a
// collapsed default so a large backlog can't push the rest of the dashboard
// (Runners, Upcoming schedules) below the fold.
//
// Bulk release (ISS-621): rows with a resolvable issue get a checkbox;
// selecting ≥1 reveals a "Release {n}" action that fans out tested→released
// via the same `useBulkUpdateIssues` hook the Issues-list bulk bar uses. That
// hook only invalidates `['issues']` — it has no notion of the dashboard's
// runs query — so on success we explicitly invalidate `['pipeline-runs']`
// ourselves; without it a released run would linger on this card until an
// unrelated refetch happened to occur.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent, Checkbox, Icon, StatusChip } from "@/design";
import { useBulkUpdateIssues } from "@/features/issues/hooks";
import { formatUsd } from "@/features/pipeline/derive";
import type { PipelineRunListItem } from "@/features/pipeline/types";

const COLLAPSED_LIMIT = 5;

/** Oldest-parked first — the longest a run has sat awaiting release is the
 *  clearest signal of what to triage first. */
function byOldestFirst(runs: PipelineRunListItem[]): PipelineRunListItem[] {
  return [...runs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

export function AwaitingReleaseCard({ runs, slug }: { runs: PipelineRunListItem[]; slug: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const bulk = useBulkUpdateIssues();
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const sorted = byOldestFirst(runs);
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = sorted.length - visible.length;
  const selectableVisible = visible.filter((run) => run.issueId != null);
  const selectedCount = selected.size;
  const allVisibleSelected =
    selectableVisible.length > 0 && selectableVisible.every((run) => selected.has(run.issueId as string));

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

  const release = () => {
    bulk.mutate(
      { ids: [...selected], update: { kind: "status", toStatus: "released" } },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: ["pipeline-runs"] });
          setSelected(new Set());
        },
      },
    );
  };

  return (
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
                  loading={bulk.isPending}
                  onClick={release}
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
  );
}
