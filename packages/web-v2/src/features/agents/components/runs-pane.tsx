"use client";

import { useMemo, useState } from "react";
import { EmptyState, ErrorState, Input, Skeleton } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { applyFilters, type StateFilter } from "../filter";
import { useRunSessions } from "../hooks";
import { RunRow } from "./run-row";

const FILTERS: Array<{ value: StateFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Not progressing" },
  { value: "working", label: "Working" },
];

export interface RunsPaneProps {
  scope: { projectId: string };
}

export function RunsPane({ scope }: RunsPaneProps) {
  const { data, isLoading, isError, error, refetch } = useRunSessions(scope.projectId);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<StateFilter>("all");

  const all = data?.items ?? [];
  const rows = useMemo(() => applyFilters(all, q, filter), [all, q, filter]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2 p-4" aria-busy="true">
        <Skeleton className="h-9 w-full max-w-sm" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="grid min-h-[40vh] place-items-center p-4">
        <ErrorState message={formatApiError(error)} onRetry={() => refetch()} />
      </div>
    );
  }

  // cm:guard the first-run empty and the empty-SEARCH are different screens, and this is the branch that keeps them apart: a box that is simply idle needs telling that runs will appear here, and a reader whose filter matched nothing needs the filter cleared. One shared "nothing here" sends the second reader looking for a fault that is not there (project ux-contract §2).
  if (all.length === 0) {
    return (
      <div className="grid min-h-[40vh] place-items-center p-4">
        <EmptyState
          title="No runs on this project"
          message="A run appears here as soon as a master opens one on a box serving this project."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
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
          message={q.trim() === "" ? "No runs in this state right now." : `No runs match “${q.trim()}”.`}
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
            <RunRow key={row.runId} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
