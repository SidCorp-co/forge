"use client";

// Awaiting-release card — pipeline runs parked at the manual `tested` gate:
// done and verified, just waiting on a human to advance tested→released. These
// are NOT live/executing work (see `LiveRunsCard`), so they get their own
// list with a calm "Verified" chip instead of the pulsing "running" one, and a
// collapsed default so a large backlog can't push the rest of the dashboard
// (Runners, Upcoming schedules) below the fold.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, Icon, StatusChip } from "@/design";
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
  const [expanded, setExpanded] = useState(false);
  const sorted = byOldestFirst(runs);
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = sorted.length - visible.length;

  const open = (run: PipelineRunListItem) => {
    router.push(run.issueId ? `/projects/${slug}/issues/${run.issueId}` : `/projects/${slug}/pipeline`);
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
            <ul className="flex flex-col gap-2">
              {visible.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => open(run)}
                    className="flex w-full items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
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
