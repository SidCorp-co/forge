"use client";

import { useMemo, useState } from "react";
import { EmptyState, ErrorState, Input, Skeleton } from "@/design";
import { useNow } from "@/design/hooks/use-now";
import { useProjectRuns } from "@/features/pipeline/hooks";
import { formatApiError } from "@/lib/api/error";
import { applyFilters, type StateFilter } from "../filter";
import { useRunSessions } from "../hooks";
import { stalledRuns } from "../stalled-runs";
import { RunRow } from "./run-row";

const FILTERS: Array<{ value: StateFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Not progressing" },
  { value: "working", label: "Working" },
];

export interface RunsPaneProps {
  scope: { projectId: string };
}

/**
 * How many pipeline runs on this project are open with nothing working on them.
 */
// cm:guard this renders ABOVE the ledger and OUTSIDE its first-run-empty branch, which is not a layout choice: an orphaned pipeline run is one whose box is long gone, so it has no ledger row at all and the ledger's "No runs on this project" screen is exactly the state it shows up in. Put inside that branch the count would be invisible in the only case it was built for (ISS-998).
function StalledBand({ projectId, now }: { projectId: string; now: number }) {
  const runsQ = useProjectRuns(projectId);
  const loading = runsQ.isLoading;
  const failed = runsQ.isError;

  const stalled = useMemo(
    () => stalledRuns(runsQ.data?.items, now),
    [runsQ.data, now],
  );

  if (loading) {
    return <Skeleton variant="rect" className="h-8 w-full max-w-md" aria-busy="true" />;
  }

  // cm:guard a failed read says so and offers the retry rather than rendering "0 runs": a zero a reader cannot tell from an unanswered question is the reassurance this band exists to stop giving.
  if (failed) {
    return (
      <p className="fg-caption text-muted">
        Couldn&apos;t read this project&apos;s runs —{" "}
        {formatApiError(runsQ.error)}{" "}
        <button
          type="button"
          className="underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          onClick={() => {
            void runsQ.refetch();
          }}
        >
          Retry
        </button>
      </p>
    );
  }

  return (
    <p className="fg-caption text-muted">
      {stalled.length === 0
        ? "Every open run has a job or a live agent behind it."
        : `${stalled.length} open ${stalled.length === 1 ? "run has" : "runs have"} nothing working on ${
            stalled.length === 1 ? "it" : "them"
          } — no live job and no agent still reporting.`}
    </p>
  );
}

export function RunsPane({ scope }: RunsPaneProps) {
  const { data, isLoading, isError, error, refetch } = useRunSessions(scope.projectId);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<StateFilter>("all");
  // cm:guard ONE instant for the whole pane, ticking on its own: two rows grading the same heartbeat against two `Date.now()` calls can straddle a threshold and disagree, and a clock read once at mount freezes the silence count on an open screen (ISS-998).
  const now = useNow(10_000);

  const all = data?.items ?? [];
  const rows = useMemo(() => applyFilters(all, q, filter, now), [all, q, filter, now]);

  return (
    <div className="flex flex-col gap-3 p-4">
      <StalledBand projectId={scope.projectId} now={now} />
      {isLoading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-9 w-full max-w-sm" />
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : isError ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ErrorState message={formatApiError(error)} onRetry={() => refetch()} />
        </div>
      ) : all.length === 0 ? (
        // cm:guard the first-run empty and the empty-SEARCH are different screens, and this is the branch that keeps them apart: a box that is simply idle needs telling that runs will appear here, and a reader whose filter matched nothing needs the filter cleared. One shared "nothing here" sends the second reader looking for a fault that is not there. The rule: first-run empty and empty-search are two states, and a searchable surface owes both.
        <div className="grid min-h-[40vh] place-items-center">
          <EmptyState
            title="No runs on this project"
            message="A run appears here as soon as a master opens one on a box serving this project."
          />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              icon="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by issue, box or worktree"
              aria-label="Filter runs"
              className="w-full sm:max-w-sm"
            />
            <fieldset className="flex flex-none items-center gap-1 border-0 p-0">
              <legend className="sr-only">Run state</legend>
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFilter(f.value)}
                  aria-pressed={filter === f.value}
                  className="fg-caption rounded-md border border-line px-2 py-1 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] max-md:min-h-[36px]"
                  style={
                    filter === f.value
                      ? { background: "var(--paper-200)", color: "var(--fg)" }
                      : { color: "var(--fg-muted)" }
                  }
                >
                  {f.label}
                </button>
              ))}
            </fieldset>
          </div>

          {rows.length === 0 ? (
            <EmptyState
              mascot={false}
              title="No runs match"
              message={
                q.trim() === "" ? "No runs in this state right now." : `No runs match “${q.trim()}”.`
              }
              action={{
                label: "Clear filters",
                onClick: () => {
                  setQ("");
                  setFilter("all");
                },
              }}
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((row) => (
                <RunRow key={row.runId} row={row} now={now} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
