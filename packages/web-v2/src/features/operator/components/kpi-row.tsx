"use client";

import { PageSection, Skeleton } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
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

export function Kpis({ overview }: { overview: AdminOverview }) {
  const t = useCopy();
  const { counts, kpis } = overview;
  const spendDelta = formatDelta(
    kpis.spendBaselineUsd > 0
      ? ((kpis.spendWindowUsd - kpis.spendBaselineUsd) / kpis.spendBaselineUsd) * 100
      : null,
  );

  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-4 lg:grid-cols-4">
      <Tile
        label={t("operator.kpi.openAlerts")}
        value={formatCount(kpis.openAlerts)}
        note={kpis.openAlerts === 0 ? null : t("operator.kpi.needsOperator")}
      />
      <Tile label={t("operator.kpi.jobsInFlight")} value={formatCount(kpis.inFlightJobs)} />
      <Tile
        label={t("operator.kpi.activeWorkspaces")}
        value={formatCount(counts.activeWorkspaces)}
        note={t("operator.kpi.workspacesOf", { projects: formatCount(counts.projects), online: formatCount(counts.devicesOnline), total: formatCount(counts.devicesTotal) })}
      />
      <Tile
        label={t("operator.kpi.spend")}
        value={formatUsd(kpis.spendWindowUsd)}
        note={spendDelta ? t("operator.kpi.spendVs", { delta: spendDelta }) : t("operator.kpi.noBaseline")}
      />
    </div>
  );
}
