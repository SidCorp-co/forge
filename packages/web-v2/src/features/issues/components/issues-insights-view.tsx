"use client";

// Issues Insights view (the "Insights" tab of the Issues screen, ISS-364). Two figures, both from
// REAL endpoints:
//   • median + cost per step → `useStepDurations`, folded onto the job type each row carries
//   • throughput             → `useThroughput` daily shipped (closed/released) count
//
// ISS-999 deleted the third panel — a seven-card funnel whose "N in stage" counts came from a
// hand-written status→stage map against a pipeline ISS-897 removed from the kernel. Its median and
// cost halves were real and are not lost: they are the same numbers "Where time goes" shows, and
// the funnel's loading skeleton went with it.
//
// The mock's "shipped vs failed", pass-% and "18% sent back" drop-off rely on rework / pass-rate
// telemetry the pipeline does NOT expose, so those stay out rather than being guessed.

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
  aggregateStepCosts,
  formatDurationSec,
  formatUsd,
} from "@/features/pipeline/derive";
import { useStepDurations, useThroughput } from "@/features/pipeline/hooks";
import type { ThroughputRow } from "@/features/pipeline/types";

interface IssuesInsightsViewProps {
  scope: { projectId: string; slug: string };
}

const WINDOW_DAYS = 7;

export function IssuesInsightsView({ scope }: IssuesInsightsViewProps) {
  const { projectId } = scope;

  useRoom(projectRoom(projectId));

  const durationsQ = useStepDurations({ projectId, days: WINDOW_DAYS });
  const throughputQ = useThroughput({ projectId, days: WINDOW_DAYS });

  const steps = useMemo(() => aggregateStepCosts(durationsQ.data), [durationsQ.data]);
  const maxMedian = Math.max(1, ...steps.map((s) => s.medianSec));
  const slowest = steps[0] ?? null;

  const isError = durationsQ.isError || throughputQ.isError;
  const isLoading = durationsQ.isLoading || throughputQ.isLoading;

  if (isError) {
    return (
      <ErrorState
        title="Couldn't load insights"
        message={formatApiError(durationsQ.error ?? throughputQ.error)}
        onRetry={() => {
          durationsQ.refetch();
          throughputQ.refetch();
        }}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-5">
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

        <Card>
          <CardHeader>
            <CardTitle>Where time goes</CardTitle>
            <Stat icon="clock" mono={false}>
              {samples} step{samples === 1 ? "" : "s"} · {WINDOW_DAYS}d
            </Stat>
          </CardHeader>
          <CardContent>
            {slowest == null ? (
              <EmptyState
                title="No steps yet"
                message={`No agent step finished in the last ${WINDOW_DAYS} days.`}
                mascot={false}
              />
            ) : (
              <div className="flex flex-col gap-2.5">
                {steps.map((s) => (
                  <div key={s.step} className="flex items-center gap-2.5">
                    <span
                      className="max-w-[96px] flex-none truncate font-mono text-12 lowercase text-muted"
                      title={s.step}
                    >
                      {s.step}
                    </span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
                      <span
                        className="block h-full rounded-full"
                        style={{
                          width: `${(s.medianSec / maxMedian) * 100}%`,
                          background: s.color,
                        }}
                      />
                    </span>
                    <span className="w-14 flex-none text-right font-mono text-12 text-fg">
                      {formatDurationSec(s.medianSec)}
                    </span>
                    <span className="w-14 flex-none text-right font-mono text-12 text-muted">
                      {formatUsd(s.cost)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 border-t border-line pt-3">
              <p className="fg-caption mb-1">Flow signal</p>
              {slowest != null ? (
                <p className="fg-body-sm text-muted">
                  Slowest step:{" "}
                  <span className="font-mono lowercase text-fg">{slowest.step}</span> at a{" "}
                  <span className="font-mono text-fg">{formatDurationSec(slowest.medianSec)}</span>{" "}
                  median over {slowest.samples} run{slowest.samples === 1 ? "" : "s"}. Rework,
                  pass-rate and per-step drop-off aren't tracked in pipeline telemetry yet, so
                  duration is the closest available bottleneck signal.
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

/** A series the chart may draw: exactly `days` rows, one per consecutive calendar date, oldest first. */
type ThroughputSeries =
  | { ok: true; days: ThroughputRow[] }
  | { ok: false; reason: string };

const DAY_MS = 86_400_000;

function utcDay(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date ? null : t;
}

/** The server owns the calendar (ISS-1149); this only refuses a series that is not one, by name,
 *  because an axis rebuilt from whatever rows arrived is the defect that issue removed. */
export function readThroughputSeries(rows: ThroughputRow[], days: number): ThroughputSeries {
  if (rows.length !== days) {
    return { ok: false, reason: `Expected ${days} consecutive days, received ${rows.length}.` };
  }
  const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  let previous: number | null = null;
  for (const row of ordered) {
    const t = utcDay(row.date);
    if (t === null) return { ok: false, reason: `"${row.date}" is not a calendar date.` };
    if (previous !== null && t - previous !== DAY_MS) {
      const before = new Date(previous).toISOString().slice(0, 10);
      return { ok: false, reason: `${before} is followed by ${row.date}, so the days are not consecutive.` };
    }
    previous = t;
  }
  return { ok: true, days: ordered };
}

/** Daily shipped bars over seven consecutive UTC days, a zero day drawn at zero height in its own
 *  place. Each bar prints its count, and the caption sums exactly the bars drawn. */
export function ThroughputChart({ rows }: { rows: ThroughputRow[] | undefined }) {
  const series = useMemo(() => readThroughputSeries(rows ?? [], WINDOW_DAYS), [rows]);

  if (!series.ok) {
    return (
      <ErrorState title="Throughput can't be drawn" message={series.reason} mascot={false} />
    );
  }

  const total = series.days.reduce((a, r) => a + r.count, 0);
  const max = Math.max(1, ...series.days.map((r) => r.count));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2 border-b border-line" style={{ height: 120 }}>
        {series.days.map((r) => (
          <div key={r.date} className="flex h-full flex-1 flex-col items-center gap-1">
            <span className="font-mono text-11 text-fg" data-testid="throughput-count">
              {r.count}
            </span>
            <div className="relative w-full min-h-0 flex-1">
              <span
                className="absolute inset-x-0 bottom-0 block rounded-t bg-[var(--stage-release)]"
                style={{ height: r.count === 0 ? "0%" : `${Math.max(4, (r.count / max) * 100)}%` }}
                title={`${r.count} shipped on ${r.date}`}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        {series.days.map((r) => (
          <span
            key={r.date}
            className="flex flex-1 flex-col items-center font-mono text-11 text-subtle"
            data-testid="throughput-day"
          >
            <span>{weekday(r.date)}</span>
            <span>{Number(r.date.slice(8))}</span>
          </span>
        ))}
      </div>
      <p className="fg-body-sm text-muted">
        <span className="font-mono text-fg">{total}</span> shipped over the last {WINDOW_DAYS} days
        (UTC).
      </p>
    </div>
  );
}

/** `2026-06-04` → `Thu`, read as the UTC date the server bucketed it under. */
function weekday(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    timeZone: "UTC",
  });
}
