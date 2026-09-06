"use client";

import { Card, Skeleton } from "@/design";
import { formatCount, formatDelta, formatUsd } from "../format";
import type { AdminOverview } from "../types";

function Tile({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <Card className="px-4 py-3.5">
      <p className="fg-overline">{label}</p>
      <p className="fg-h1 mt-1 font-mono tabular-nums">{value}</p>
      {note && <p className="fg-caption mt-0.5">{note}</p>}
    </Card>
  );
}

export function KpiRowSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <Card key={i} className="px-4 py-3.5">
          <Skeleton variant="text" className="w-20" />
          <Skeleton className="mt-2 h-7 w-16" />
        </Card>
      ))}
    </div>
  );
}

// cm:edge contract -> packages/core/src/admin/aggregate-routes.ts — `kpis.openAlerts` there is an independent approximation of A2 (running-only, no A1/A3/A4/A5) that ISS-654 will unify; until it does, this tile counts the alerts the feed one card below is showing, because "0 · nothing needs you" printed above a red crit row is the state-lies failure VISION №10 forbids
export function KpiRow({ overview, openAlerts }: { overview: AdminOverview; openAlerts: number | null }) {
  const { counts, kpis } = overview;
  const spendDelta = formatDelta(
    kpis.spendBaselineUsd > 0
      ? ((kpis.spendWindowUsd - kpis.spendBaselineUsd) / kpis.spendBaselineUsd) * 100
      : null,
  );

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        label="Open alerts"
        value={formatCount(openAlerts)}
        note={openAlerts === 0 ? "nothing needs you" : "needs an operator"}
      />
      <Tile label="Jobs in flight" value={formatCount(kpis.inFlightJobs)} note="queued, dispatched or running" />
      <Tile
        label="Active workspaces"
        value={formatCount(counts.activeWorkspaces)}
        note={`of ${formatCount(counts.projects)} · ${formatCount(counts.devicesOnline)}/${formatCount(counts.devicesTotal)} runners online`}
      />
      <Tile
        label="Spend this window"
        value={formatUsd(kpis.spendWindowUsd)}
        note={spendDelta ? `${spendDelta} vs the window before` : "no baseline to compare"}
      />
    </div>
  );
}
