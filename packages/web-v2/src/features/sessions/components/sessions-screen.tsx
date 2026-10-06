"use client";

// A project's Sessions index under the Agents shell (ISS-291). Rows link to the
// session detail (`/projects/:slug/agents/:id`) and back to their issue (ISS-331).
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  EmptyState,
  ErrorState,
  PageContainer,
  Pagination,
  SegmentedControl,
  SessionRowSkeleton,
  type SegmentOption,
} from "@/design";
import { useIssue } from "@/features/issues/detail-hooks";
import { useProject } from "@/features/projects/hooks";
import { formatRefusal } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { SESSIONS_PAGE_SIZE } from "../api";
import { FleetStrip } from "./fleet-strip";
import {
  useAbortSession,
  useCancelSession,
  useRerunSession,
  useRetrySession,
  useSessions,
  useSweepZombies,
} from "../hooks";
import { deriveSessionDisplayStatus, type SessionFilter, type StuckRuns } from "../types";
import {
  FILTERS,
  FILTER_LABEL,
  KIND_FILTERS,
  KIND_LABEL,
  type KindFilter,
  filterCounts,
  kindCounts,
  matchesFilter,
  matchesKind,
  sessionStats,
} from "./session-filters";
import { SessionList } from "./session-rows";
import { SessionsHeader } from "./sessions-header";
import { orderByOwner } from "./session-tree";

/** Narrows the list to one issue's sessions, with the way back to all of them. */
export interface SessionsIssueFilter {
  issueId: string;
  clearHref: string;
}

export function SessionsScreen({
  projectId,
  issueFilter,
  stuck,
}: {
  projectId: string;
  issueFilter: SessionsIssueFilter | null;
  stuck: StuckRuns;
}) {
  // Counts and tabs are computed over one page of the newest sessions; the pager and its caption
  // say which page, so a tab never claims to cover sessions it was not given.
  const [page, setPage] = useState(1);
  const issueId = issueFilter?.issueId;
  const sessionsQ = useSessions({ projectId, issueId, page });
  const issueQ = useIssue(issueId, projectId);
  const total = sessionsQ.data?.totalCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / SESSIONS_PAGE_SIZE));
  const [filter, setFilter] = useState<SessionFilter>("all");
  // ISS-465 — kind dimension (Runs vs Chats); presentation-only.
  const [kind, setKind] = useState<KindFilter>("all");

  // A device id resolves to its name through the project's pool; an unknown id renders as a short MonoTag.
  const projectDetailQ = useProject(projectId);
  const slug = projectDetailQ.data?.slug;
  const deviceNameById = useMemo(
    () => new Map((projectDetailQ.data?.devicePool ?? []).map((d) => [d.id, d.name] as const)),
    [projectDetailQ.data],
  );

  // The event-router invalidates ['agent-sessions'] on this room's events.
  useRoom(projectRoom(projectId));

  const cancel = useCancelSession();
  const retry = useRetrySession();
  const rerun = useRerunSession();
  const abort = useAbortSession();
  const sweep = useSweepZombies();

  // ISS-465 — kind counts come from the page before the kind filter.
  const kindRows = useMemo(() => sessionsQ.data?.items ?? [], [sessionsQ.data]);
  const rows = useMemo(() => kindRows.filter((r) => matchesKind(kind, r)), [kindRows, kind]);

  const now = Date.now();
  const displays = useMemo(
    () => rows.map((r) => deriveSessionDisplayStatus(r, stuck)),
    [rows, stuck],
  );

  const stats = useMemo(() => sessionStats(rows, displays, now), [rows, displays, now]);
  const counts = useMemo(() => filterCounts(rows, displays), [rows, displays]);

  const visibleRows = useMemo(() => {
    return rows
      .map((r, i) => ({ row: r, display: displays[i] }))
      .filter(({ row, display }) => matchesFilter(filter, row, display))
      .map(({ row }) => row);
  }, [rows, displays, filter]);

  // A pure derivation so it can be tested without a browser; session-tree.ts
  // says what happens to a row whose owner a filter excluded.
  const treeRows = useMemo(() => orderByOwner(visibleRows), [visibleRows]);

  const filterOptions: SegmentOption<SessionFilter>[] = FILTERS.map((f) => ({
    value: f,
    label: `${FILTER_LABEL[f]} ${counts[f]}`,
  }));

  const kindTotals = kindCounts(kindRows);
  const kindOptions: SegmentOption<KindFilter>[] = KIND_FILTERS.map((k) => ({
    value: k,
    label: `${KIND_LABEL[k]} ${kindTotals[k]}`,
  }));

  const actions = { cancel, retry, rerun, abort };

  return (
    <PageContainer className="min-h-dvh">
      <SessionsHeader stats={stats} sweeping={sweep.isPending} onSweep={() => sweep.mutate(projectId)} />

      {issueFilter && (
        <div className="mb-4 flex flex-wrap items-baseline gap-3 border-b border-line-subtle pb-2" data-testid="sessions-issue-filter">
          <span className="text-13 font-medium text-fg">
            Sessions of {issueQ.data?.displayId ?? "this issue"}
            {issueQ.data?.title ? <span className="text-muted"> · {issueQ.data.title}</span> : null}
          </span>
          <Link href={issueFilter.clearHref} className="fg-caption text-accent-text hover:opacity-80">
            Show all sessions
          </Link>
        </div>
      )}

      {/* Fleet-runner rollup (ISS-378) — per-device chips + the no-runner banner. */}
      <div className="mb-4">
        <FleetStrip projectId={projectId} rows={rows} displays={displays} now={now} stuck={stuck} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 overflow-x-auto">
        <SegmentedControl options={kindOptions} value={kind} onChange={setKind} />
        <SegmentedControl options={filterOptions} value={filter} onChange={setFilter} />
        {total > 0 && (
          <div className="ml-auto flex items-center gap-2 whitespace-nowrap">
            <span className="fg-caption text-subtle">
              Counts cover sessions {(page - 1) * SESSIONS_PAGE_SIZE + 1}–
              {Math.min(page * SESSIONS_PAGE_SIZE, total)} of {total}, newest first
            </span>
            {pageCount > 1 && <Pagination page={page} pageCount={pageCount} onChange={setPage} />}
          </div>
        )}
      </div>

      {sessionsQ.isLoading && (
        <div className="border-t border-line">
          {Array.from({ length: 6 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed-length placeholder list that never reorders
            <SessionRowSkeleton key={i} />
          ))}
        </div>
      )}

      {issueQ.isError && (
        <ErrorState
          title="Couldn't read the issue these sessions are filtered to"
          message={formatRefusal(issueQ.error)}
          onRetry={() => issueQ.refetch()}
        />
      )}

      {sessionsQ.isError && (
        <ErrorState
          title="Couldn't load sessions"
          message={formatRefusal(sessionsQ.error)}
          onRetry={() => sessionsQ.refetch()}
        />
      )}

      {!sessionsQ.isLoading && !sessionsQ.isError && !issueQ.isError && rows.length === 0 && (
        <EmptyState
          title={issueFilter ? "No sessions for this issue" : "No sessions yet"}
          message={
            issueFilter
              ? "No agent session has worked this issue yet."
              : "Agent sessions for this project will appear here as the pipeline runs."
          }
        />
      )}

      {!sessionsQ.isLoading && !sessionsQ.isError && rows.length > 0 && visibleRows.length === 0 && (
        // ISS-664 — the "waiting for me" tab reads distinctly from a plain
        // filtered-empty ("nothing matches"): being empty here is a good
        // outcome (caught up), not a dead end.
        <EmptyState
          title={filter === "waiting" ? "You're all caught up" : "Nothing here"}
          message={
            filter === "waiting"
              ? "No conversations are waiting on your reply right now."
              : "No sessions match this filter."
          }
          mascot={false}
        />
      )}

      {!sessionsQ.isLoading && !sessionsQ.isError && !issueQ.isError && visibleRows.length > 0 && (
        <SessionList
          treeRows={treeRows}
          slug={slug}
          deviceNameById={deviceNameById}
          now={now}
          stuck={stuck}
          actions={actions}
        />
      )}
    </PageContainer>
  );
}
