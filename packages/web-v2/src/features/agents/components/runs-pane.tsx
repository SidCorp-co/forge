"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { EmptyState, ErrorState, Input, MonoTag, Skeleton } from "@/design";
import { useNow } from "@/design/hooks/use-now";
import { useProjectRuns } from "@/features/runs/hooks";
import { NO_BOX_REPORTS_A_RUN, NO_RUN_WORKING, RUN_APPEARS } from "@/features/sessions/status-sentences";
import { runReadingChip, runSinceWord } from "@/features/runs/derive";
import { RUN_KIND_WORD, RUN_STATUS_WORD } from "@/features/runs/run-status-words";
import type { PipelineRunListItem } from "@/features/runs/types";
import { formatApiError } from "@/lib/api/error";
import { formatRelativeTime } from "@/lib/utils/format";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
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
  completed: RUN_STATUS_WORD.completed,
  failed: RUN_STATUS_WORD.failed,
  cancelled: RUN_STATUS_WORD.cancelled,
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
 * What a run worked: its one issue, or each issue a box opened it over (an issue page takes a
 * display key as its id, ISS-1160), each with its title as a job run shows its one issue's, and only
 * where it names neither, the kind of run it was.
 */
function RunWork({ run, slug }: { run: PipelineRunListItem; slug: string }) {
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

/** An open run in the word its drawer reads it by, and since when. */
function OpenRunRow({ run, slug, now }: { run: PipelineRunListItem; slug: string; now: number }) {
  return (
    <li className="flex items-baseline gap-3 py-2">
      <span className="min-w-0 flex-1">
        <RunWork run={run} slug={slug} />
      </span>
      <span className="flex flex-none items-baseline gap-3 whitespace-nowrap">
        <span data-run-status className="fg-body-sm text-fg">
          {runReadingChip(run, now).label}
        </span>
        <span data-run-since className="fg-caption tabular-nums">
          {runSinceWord(run, now)} {formatRelativeTime(run.startedAt)}
        </span>
      </span>
    </li>
  );
}

/** A run by the issues it worked, else by its kind, as the band names it. */
function runName(run: PipelineRunListItem): string {
  if (run.issueRef) return run.issueRef;
  if (run.group.issues.length > 0) return run.group.issues.join(" + ");
  return RUN_KIND_WORD[run.kind] ?? run.kind;
}

/**
 * What the tab shows where no box reports a run: every open run, each in the word the run drawer
 * reads it by, the runs that have closed, and above nothing, that none is working.
 */
function NothingRunning({ projectId, slug, now }: { projectId: string; slug: string; now: number }) {
  const runsQ = useProjectRuns(projectId);
  const closed = useMemo(() => closedRuns(runsQ.data?.items), [runsQ.data]);
  // Every open run, the band's stalled ones included, so no run is named or counted and not shown.
  const open = useMemo(() => openRuns(runsQ.data?.items), [runsQ.data]);
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
          message={RUN_APPEARS}
        />
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-2">
      {/* Said only above nothing: an open run listed beneath it is one a box may hold (ISS-1228). */}
      {open.length === 0 && (
        <p className="fg-body-sm text-fg">{readWhole ? NO_RUN_WORKING : NO_BOX_REPORTS_A_RUN}</p>
      )}
      {open.length > 0 && (
        <>
          <h3 className="fg-caption mt-2">Open runs · {open.length}</h3>
          <ul aria-label="Open runs" className="flex flex-col divide-y divide-line border-y border-line">
            {open.map((r) => (
              <OpenRunRow key={r.id} run={r} slug={slug} now={now} />
            ))}
          </ul>
        </>
      )}
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
                  <RunWork run={r} slug={slug} />
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
  const worked = useMemo(() => workedRuns(runsQ.data?.items), [runsQ.data]);

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

  // A paused run, or one still starting up, is neither stalled nor worked: no reassurance covers it.
  if (stalled.length === 0) {
    return worked.length === open.length ? (
      <p className="fg-caption text-muted">Every open run has a job or a live agent behind it.</p>
    ) : null;
  }
  // Each run named, opening its drawer: the rows below list worked runs, so the band is where these are found.
  return (
    <p className="fg-caption text-muted">
      {stalled.map((r, i) => (
        <span key={r.id}>
          {i > 0 && (i === stalled.length - 1 ? " and " : ", ")}
          <Link href={`/ops?run=${r.id}`} className="underline focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]">
            {runName(r)}
          </Link>
        </span>
      ))}
      {stalled.length === 1 ? " has nothing working on it" : " have nothing working on them"} — no live job and no
      agent still reporting.
    </p>
  );
}

/** Whether the tab's search and state filter keep an open run nothing works: never Working, and a
 *  search over what its row shows. */
function keepsStalled(run: PipelineRunListItem, q: string, filter: StateFilter): boolean {
  if (filter === "working") return false;
  const needle = q.trim().toLowerCase();
  const hay = [runName(run), run.issueTitle ?? "", ...Object.values(run.groupTitles ?? {})].join(" ").toLowerCase();
  return hay.includes(needle);
}

/** Beside the runs boxes report, every open run nothing works, so each run the band names is a row
 *  on this tab (ISS-1228). */
function StalledRunRows({ runs, slug, now }: { runs: readonly PipelineRunListItem[]; slug: string; now: number }) {
  if (runs.length === 0) return null;
  return (
    <>
      <h3 className="fg-caption mt-2">Nothing working · {runs.length}</h3>
      <ul aria-label="Open runs nothing works" className="flex flex-col divide-y divide-line border-y border-line">
        {runs.map((r) => (
          <OpenRunRow key={r.id} run={r} slug={slug} now={now} />
        ))}
      </ul>
    </>
  );
}

export function RunsPane({ scope }: RunsPaneProps) {
  useRoom(projectRoom(scope.projectId));
  const { data, isLoading, isError, error, refetch } = useRunSessions(scope.projectId);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<StateFilter>("all");
  const now = useNow(10_000);

  const all = data?.items ?? [];
  const rows = useMemo(() => applyFilters(all, q, filter, now), [all, q, filter, now]);
  const runsQ = useProjectRuns(scope.projectId);
  const stalled = useMemo(
    () => stalledRuns(runsQ.data?.items, now).filter((r) => keepsStalled(r, q, filter)),
    [runsQ.data, now, q, filter],
  );

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
        <NothingRunning projectId={scope.projectId} slug={scope.slug} now={now} />
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

          {rows.length === 0 && stalled.length === 0 ? (
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
            rows.length > 0 && (
              <ul aria-label="Runs a box reports" className="flex flex-col divide-y divide-line border-y border-line">
                {rows.map((row) => (
                  <RunRow key={row.runId} row={row} now={now} slug={scope.slug} />
                ))}
              </ul>
            )
          )}
          <StalledRunRows runs={stalled} slug={scope.slug} now={now} />
        </>
      )}
    </div>
  );
}
