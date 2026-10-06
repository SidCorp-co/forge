"use client";

import { PageSection, Skeleton } from "@/design";
import { formatCount, formatDelta, formatUsd } from "../format";
import type { AdminOverview } from "../types";

function Tile({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <PageSection className="py-3.5">
      <p className="fg-overline">{label}</p>
      <p className="fg-h1 mt-1 font-mono tabular-nums">{value}</p>
      {note && <p className="fg-caption mt-0.5">{note}</p>}
    </PageSection>
  );
}

export function KpiRowSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-4 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <PageSection key={i} className="py-3.5">
          <Skeleton variant="text" className="w-20" />
          <Skeleton className="mt-2 h-7 w-16" />
        </PageSection>
      ))}
    </div>
  );
}

export function KpiRow({ overview }: { overview: AdminOverview }) {
  const { counts, kpis } = overview;
  const spendDelta = formatDelta(
    kpis.spendBaselineUsd > 0
      ? ((kpis.spendWindowUsd - kpis.spendBaselineUsd) / kpis.spendBaselineUsd) * 100
      : null,
  );

  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-4 lg:grid-cols-4">
      <Tile
        label="Open alerts"
        value={formatCount(kpis.openAlerts)}
        note={kpis.openAlerts === 0 ? "nothing needs you" : "needs an operator"}
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
