"use client";

import type { RunStanding, RunStandingList } from "@forge/contracts/run-standing";
import { useMemo, useState } from "react";
import { EmptyState, ErrorState, Input, Skeleton, StatusBadge } from "@/design";
import { enumLabel } from "@/design/vocabulary";
import { formatApiError } from "@/lib/api/error";
import { applyFilters, type StandingBySession, type StateFilter, standingOf } from "../filter";
import { useRunSessions, useRunStanding } from "../hooks";
import { RunRow } from "./run-row";

const FILTERS: Array<{ value: StateFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Not progressing" },
  { value: "working", label: "Working" },
];

export interface RunsPaneProps {
  scope: { projectId: string };
}

const STUCK_SHOWN = 5;

function StuckBand({ q }: { q: ReturnType<typeof useRunStanding> }) {
  const runsQ = q;
  const loading = runsQ.isLoading;
  const failed = runsQ.isError;
  const data: RunStandingList | undefined = runsQ.data;
  const stuck = useMemo(() => (data?.items ?? []).filter((r) => r.state === "stuck"), [data]);

  if (loading) {
    return <Skeleton variant="rect" className="h-8 w-full max-w-md" aria-busy="true" />;
  }

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

  const count = data?.counts.liveByState.stuck ?? 0;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="fg-caption flex flex-wrap items-center gap-2 text-muted">
        <span>Project master</span>
        {data ? <StatusBadge family="masterState" value={data.master.state} /> : null}
        <span aria-hidden="true">·</span>
        <span>
          {count === 0
            ? "No open run is stuck."
            : `${count} open ${count === 1 ? "run is" : "runs are"} stuck: nothing has moved ${count === 1 ? "it" : "them"} past the 3 min threshold.`}
        </span>
      </p>
      {stuck.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {stuck.slice(0, STUCK_SHOWN).map((r) => (
            <StuckItem key={r.id} run={r} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StuckItem({ run }: { run: RunStanding }) {
  const s = run.stuck;
  if (s.source !== "stuck") return null;
  return (
    <li className="fg-caption flex min-w-0 items-center gap-2 text-muted" title={`${s.detail}\n${s.failsBy}`}>
      <StatusBadge family="runStanding" value={run.state} />
      <span className="truncate text-fg">{run.issue?.key ?? run.title}</span>
      <span className="flex-none">{enumLabel("runStuckRule", s.rule)}</span>
    </li>
  );
}

export function RunsPane({ scope }: RunsPaneProps) {
  const { data, isLoading, isError, error, refetch } = useRunSessions(scope.projectId);
  const standingQ = useRunStanding(scope.projectId);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<StateFilter>("all");

  const standings: StandingBySession = useMemo(() => {
    const m = new Map<string, RunStanding>();
    for (const r of standingQ.data?.items ?? []) if (r.sessionId) m.set(r.sessionId, r);
    return m;
  }, [standingQ.data]);
  const all = data?.items ?? [];
  const rows = useMemo(() => applyFilters(all, q, filter, standings), [all, q, filter, standings]);

  return (
    <div className="flex flex-col gap-3 p-4">
      <StuckBand q={standingQ} />
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
                <RunRow key={row.runId} row={row} standing={standingOf(row, standings)} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
