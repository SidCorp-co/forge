"use client";

// The project dashboard's throughput tile: issues shipped per day over the last seven UTC days, each counted once.

import { useMemo } from "react";
import { ErrorState } from "@/design";
import type { ThroughputRow } from "@/features/runs/types";
import { formatApiError } from "@/lib/api/error";
import { throughputComparison } from "../shape";
import { DashboardSection, EmptyLine, unreadSection } from "./dashboard-section";

export const THROUGHPUT_WINDOW_DAYS = 7;
const WINDOW_DAYS = THROUGHPUT_WINDOW_DAYS;

interface ThroughputProps {
  rows: ThroughputRow[] | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}

export function Throughput({ rows, isLoading, error, onRetry }: ThroughputProps) {
  const series = useMemo(() => (rows ? readThroughputSeries(rows, WINDOW_DAYS) : null), [rows]);
  const comparison = series?.ok ? throughputComparison(series.days) : null;
  const total = series?.ok ? series.days.reduce((a, r) => a + r.count, 0) : null;

  // A read that has not arrived says so by name; it is neither a week that shipped nothing nor a skeleton.
  if (!error && isLoading) return unreadSection("Throughput", "The throughput", { read: "pending" });

  // A week that shipped nothing is one line, as every empty panel is; a failed or malformed read is not empty.
  if (!error && !isLoading && total === 0) {
    return <EmptyLine title="Throughput" status={`nothing shipped in ${WINDOW_DAYS} days`} />;
  }

  return (
    <DashboardSection title="Throughput" aside={comparison ?? `shipped · ${WINDOW_DAYS}-day`}>
      {error ? (
        <ErrorState
          title="Couldn't load throughput"
          message={formatApiError(error)}
          error={error} onRetry={onRetry}
          mascot={false}
        />
      ) : (
        <ThroughputChart rows={rows} />
      )}
    </DashboardSection>
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
      <ErrorState title="Throughput can't be drawn" message={series.reason} mascot={false} final />
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
                className="absolute inset-x-0 bottom-0 block rounded-t bg-[var(--fg-muted)]"
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
