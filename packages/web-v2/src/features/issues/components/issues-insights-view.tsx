"use client";

// Issues Insights view (the "Insights" tab of the redesigned Issues screen,
// ISS-364). All figures come from REAL endpoints — no fabricated numbers:
//   • per-stage count   → `groupIssuesByStage(useProjectIssues)`
//   • median + cost     → `useStepDurations` (the step-durations view), folded
//                         onto stages via `aggregateStageInsights`
//   • throughput        → `useThroughput` daily shipped (closed/released) count
// The mock's "shipped vs failed", pass-% and "18% sent back" drop-off rely on
// rework / pass-rate telemetry the pipeline does NOT expose, so those are
// deliberately scoped out (see the "Flow signal" panel) rather than guessed.
import { useMemo } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
  Stat,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import {
  aggregateStageInsights,
  formatDurationSec,
  formatUsd,
  groupIssuesByStage,
} from "@/features/pipeline/derive";
import { useProjectIssues, useStepDurations, useThroughput } from "@/features/pipeline/hooks";
import type { ThroughputRow } from "@/features/pipeline/types";

interface IssuesInsightsViewProps {
  scope: { projectId: string; slug: string };
}

const WINDOW_DAYS = 7;

export function IssuesInsightsView({ scope }: IssuesInsightsViewProps) {
  const { projectId } = scope;

  // The board issues + throughput refresh live with the rest of the screen.
  useRoom(projectRoom(projectId));

  const issuesQ = useProjectIssues(projectId);
  const durationsQ = useStepDurations({ projectId, days: WINDOW_DAYS });
  const throughputQ = useThroughput({ projectId, days: WINDOW_DAYS });

  const stages = useMemo(
    () => aggregateStageInsights(groupIssuesByStage(issuesQ.data?.items), durationsQ.data),
    [issuesQ.data, durationsQ.data],
  );

  const maxCount = Math.max(1, ...stages.map((s) => s.count));
  const maxMedian = Math.max(1, ...stages.map((s) => s.medianSec ?? 0));
  const slowest = useMemo(
    () =>
      stages.reduce<(typeof stages)[number] | null>(
        (best, s) => (s.medianSec != null && (!best || s.medianSec > (best.medianSec ?? 0)) ? s : best),
        null,
      ),
    [stages],
  );

  const isError = issuesQ.isError || durationsQ.isError || throughputQ.isError;
  const isLoading = issuesQ.isLoading || durationsQ.isLoading || throughputQ.isLoading;

  if (isError) {
    return (
      <ErrorState
        title="Couldn't load insights"
        message={formatApiError(issuesQ.error ?? durationsQ.error ?? throughputQ.error)}
        onRetry={() => {
          issuesQ.refetch();
          durationsQ.refetch();
          throughputQ.refetch();
        }}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-lg" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      </div>
    );
  }

  const samples = durationsQ.data?.length ?? 0;

  return (
    <div className="flex flex-col gap-5">
      {/* Per-stage funnel cards — count (live) + median + cost (last 7d). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        {stages.map((s) => (
          <div
            key={s.stage}
            className="overflow-hidden rounded-lg border border-line bg-surface"
          >
            <div className="h-1" style={{ background: s.color }} />
            <div className="flex flex-col gap-2 p-3">
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2 flex-none rounded-full"
                  style={{ background: s.color }}
                />
                <span className="fg-caption font-mono lowercase">{s.label}</span>
              </div>
              <div className="font-mono text-2xl font-bold leading-none text-fg">
                {s.count}
                <span className="ml-1 align-middle text-xs font-normal text-subtle">in stage</span>
              </div>
              <dl className="flex flex-col gap-1 text-[12px]">
                <div className="flex items-center justify-between">
                  <dt className="text-muted">median</dt>
                  <dd className="font-mono text-fg">
                    {s.medianSec != null ? formatDurationSec(s.medianSec) : "—"}
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted">cost · 7d</dt>
                  <dd className="font-mono text-fg">{formatUsd(s.cost)}</dd>
                </div>
              </dl>
              {/* Relative volume (share of open issues) — a real signal, not a
                  fabricated pass-rate. */}
              <div className="mt-0.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${(s.count / maxCount) * 100}%`, background: s.color }}
                  />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Throughput — daily shipped (closed/released) over the window. */}
        <Card>
          <CardHeader>
            <CardTitle>Throughput</CardTitle>
            <Stat icon="activity" mono={false}>
              shipped · {WINDOW_DAYS}-day
            </Stat>
          </CardHeader>
          <CardContent>
            <ThroughputChart rows={throughputQ.data} />
          </CardContent>
        </Card>

        {/* Where time goes — median per stage; plus an honestly-scoped flow note. */}
        <Card>
          <CardHeader>
            <CardTitle>Where time goes</CardTitle>
            <Stat icon="clock" mono={false}>
              {samples} step{samples === 1 ? "" : "s"} · {WINDOW_DAYS}d
            </Stat>
          </CardHeader>
          <CardContent>
            {slowest == null ? (
              <p className="fg-body-sm text-muted">No completed steps in the last {WINDOW_DAYS} days.</p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {stages
                  .filter((s) => s.medianSec != null)
                  .map((s) => (
                    <div key={s.stage} className="flex items-center gap-2.5">
                      <span className="w-14 flex-none font-mono text-[12px] lowercase text-muted">
                        {s.label}
                      </span>
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${((s.medianSec ?? 0) / maxMedian) * 100}%`,
                            background: s.color,
                          }}
                        />
                      </span>
                      <span className="w-16 flex-none text-right font-mono text-[12px] text-fg">
                        {formatDurationSec(s.medianSec)}
                      </span>
                    </div>
                  ))}
              </div>
            )}

            <div className="mt-4 border-t border-line pt-3">
              <p className="fg-caption mb-1">Flow signal</p>
              {slowest != null ? (
                <p className="fg-body-sm text-muted">
                  Slowest stage:{" "}
                  <span className="font-mono lowercase text-fg">{slowest.label}</span> at a{" "}
                  <span className="font-mono text-fg">{formatDurationSec(slowest.medianSec)}</span>{" "}
                  median. Rework / pass-rate and per-stage drop-off aren't tracked in pipeline
                  telemetry yet, so duration is the closest available bottleneck signal.
                </p>
              ) : (
                <p className="fg-body-sm text-muted">
                  Rework, pass-rate and drop-off aren't tracked in pipeline telemetry yet.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** Daily shipped bars. Rows arrive as `{ date, count }` for days with at least
 *  one closure; we render them in date order with heights relative to the busiest
 *  day. Honest about being shipped-only (no failed series exists server-side). */
function ThroughputChart({ rows }: { rows: ThroughputRow[] | undefined }) {
  const ordered = useMemo(
    () => [...(rows ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [rows],
  );
  const total = ordered.reduce((a, r) => a + r.count, 0);
  const max = Math.max(1, ...ordered.map((r) => r.count));

  if (ordered.length === 0) {
    return (
      <EmptyState
        title="Nothing shipped yet"
        message={`No issues were closed in the last ${WINDOW_DAYS} days.`}
        mascot={false}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2" style={{ height: 120 }}>
        {ordered.map((r) => (
          <div key={r.date} className="flex flex-1 flex-col items-center gap-1.5">
            <div className="flex w-full flex-1 items-end">
              <span
                className="block w-full rounded-t bg-[var(--stage-release)]"
                style={{ height: `${Math.max(4, (r.count / max) * 100)}%` }}
                title={`${r.count} shipped`}
              />
            </div>
            <span className="font-mono text-[11px] text-subtle">{weekday(r.date)}</span>
          </div>
        ))}
      </div>
      <p className="fg-body-sm text-muted">
        <span className="font-mono text-fg">{total}</span> shipped over the last {WINDOW_DAYS} days.
      </p>
    </div>
  );
}

/** `2026-06-04` → `Wed` (best-effort; falls back to the raw date on parse fail). */
function weekday(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? date.slice(5)
    : d.toLocaleDateString(undefined, { weekday: "short" });
}
