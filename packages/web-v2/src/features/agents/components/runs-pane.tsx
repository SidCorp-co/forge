"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { EmptyState, ErrorState, Input, MonoTag, Skeleton, STOPPED_WORD } from "@/design";
import { useNow } from "@/design/hooks/use-now";
import { useProjectRuns } from "@/features/runs/hooks";
import type { PipelineRunListItem } from "@/features/runs/types";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { applyFilters, type StateFilter } from "../filter";
import { useRunSessions } from "../hooks";
import { openRuns, stalledRuns, workedRuns } from "../stalled-runs";
import { RunRow } from "./run-row";

const FILTERS: Array<{ value: StateFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Not progressing" },
  { value: "working", label: "Working" },
];

export interface RunsPaneProps {
  scope: { projectId: string; slug: string };
}

const CLOSED_STATUS_WORD: Record<string, string> = {
  completed: "Completed",
  failed: "Failed",
  cancelled: STOPPED_WORD,
};

const RUN_KIND_WORD: Record<string, string> = {
  issue: "Issue run",
  pm: "Project manager run",
  interactive: "Chat run",
  system: "System run",
};

/** The project's runs that have closed, newest first: what the tab offers where no box reports a run. */
function closedRuns(runs: readonly PipelineRunListItem[] | undefined): PipelineRunListItem[] {
  return (runs ?? [])
    .filter((r) => Object.hasOwn(CLOSED_STATUS_WORD, r.status))
    .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt));
}

function IssueLink({ slug, href, label }: { slug: string; href: string; label: string }) {
  return (
    <Link
      href={`/projects/${slug}/issues/${href}`}
      className="flex-none hover:underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
    >
      <MonoTag>{label}</MonoTag>
    </Link>
  );
}

/** One issue a closed run worked, by its key and, where core knows it, its title. */
function WorkedIssue({ slug, href, label, title }: { slug: string; href: string; label: string; title: string | null }) {
  return (
    <span className="flex min-w-0 max-w-full items-baseline gap-2">
      <IssueLink slug={slug} href={href} label={label} />
      {title && <span className="fg-body-sm min-w-0 break-words text-muted">{title}</span>}
    </span>
  );
}

/**
 * What a closed run worked: its one issue, or each issue a box opened it over (an issue page takes a
 * display key as its id, ISS-1160), each with its title as a job run shows its one issue's, and only
 * where it names neither, the kind of run it was.
 */
function ClosedRunWork({ run, slug }: { run: PipelineRunListItem; slug: string }) {
  if (run.issueId && run.issueRef) {
    return <WorkedIssue slug={slug} href={run.issueId} label={run.issueRef} title={run.issueTitle} />;
  }
  const group = run.group.issues;
  if (group.length > 0) {
    return (
      <span className="flex min-w-0 flex-col gap-1">
        {group.map((key) => (
          <WorkedIssue
            key={key}
            slug={slug}
            href={encodeURIComponent(key)}
            label={key}
            title={run.groupTitles?.[key] ?? null}
          />
        ))}
      </span>
    );
  }
  return <span className="fg-body-sm text-fg">{RUN_KIND_WORD[run.kind] ?? run.kind}</span>;
}

/**
 * What the tab says where no box reports a run: whether any run is working, and the runs that have
 * closed, so a project whose runs all ended is never said to have none.
 */
function NothingRunning({ projectId, slug }: { projectId: string; slug: string }) {
  const runsQ = useProjectRuns(projectId);
  const closed = useMemo(() => closedRuns(runsQ.data?.items), [runsQ.data]);
  const worked = workedRuns(runsQ.data?.items).length;
  const readWhole = !runsQ.isError && runsQ.data !== undefined && runsQ.data.totalCount <= runsQ.data.items.length;
  const read = runsQ.data?.items.length ?? 0;
  const total = runsQ.data?.totalCount ?? read;

  if (runsQ.isLoading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (!runsQ.isError && total === 0) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <EmptyState
          title="No runs on this project"
          message="A run appears here as soon as a master opens one on a box serving this project."
        />
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      <p className="fg-body-sm text-fg">
        {worked > 0
          ? `No box reports a run here, though ${worked} open ${worked === 1 ? "run has" : "runs have"} work behind ${worked === 1 ? "it" : "them"}.`
          : readWhole
            ? "No run is working on this project right now."
            : "No box reports a run on this project right now."}
      </p>
      {closed.length > 0 && (
        <>
          <h3 className="fg-caption mt-2">
            Closed runs · {closed.length}
            {total > read ? ` — from the newest ${read} of ${total} runs` : ""}
          </h3>
          <ul aria-label="Closed runs" className="flex flex-col divide-y divide-line border-y border-line">
            {closed.map((r) => (
              // One rule at every width: what the run worked takes the rest of the line and wraps
              // within itself; its outcome and age hold one line of their own at the right.
              <li key={r.id} className="flex items-baseline gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <ClosedRunWork run={r} slug={slug} />
                </span>
                <span data-run-outcome className="flex flex-none items-baseline gap-3 whitespace-nowrap">
                  <span data-run-status className="fg-body-sm text-fg">
                    {CLOSED_STATUS_WORD[r.status]}
                  </span>
                  <span className="fg-caption tabular-nums">{formatRelativeTime(r.finishedAt ?? r.startedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * How many pipeline runs on this project are open with nothing working on them.
 */
function StalledBand({ projectId, now }: { projectId: string; now: number }) {
  const runsQ = useProjectRuns(projectId);
  const loading = runsQ.isLoading;
  const failed = runsQ.isError;

  const stalled = useMemo(
    () => stalledRuns(runsQ.data?.items, now),
    [runsQ.data, now],
  );
  const open = useMemo(() => openRuns(runsQ.data?.items), [runsQ.data]);

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

  // With no run open there is nothing to say about open runs: the tab below says what is running.
  if (open.length === 0) return null;

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
  const now = useNow(10_000);

  const all = data?.items ?? [];
  const rows = useMemo(() => applyFilters(all, q, filter, now), [all, q, filter, now]);

  return (
    <div className="flex flex-col gap-3 py-4">
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
        <NothingRunning projectId={scope.projectId} slug={scope.slug} />
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
                      ? { background: "var(--paper-200)", color: "var(--fg-default)" }
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
            <ul aria-label="Runs a box reports" className="flex flex-col divide-y divide-line border-y border-line">
              {rows.map((row) => (
                <RunRow key={row.runId} row={row} now={now} slug={scope.slug} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
