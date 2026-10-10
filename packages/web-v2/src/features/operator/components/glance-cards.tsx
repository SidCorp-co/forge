"use client";

import { PageSection, Skeleton, Sparkline } from "@/design";
import { TONE_META } from "@/design/status";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatDelta, formatMinutes, formatPercent, formatRatio, formatUsd, formatCount, NO_VALUE } from "../format";
import type { AdminGlanceMetric, AdminOverview } from "../types";

type GlanceKey = keyof AdminOverview["glance"];

interface GlanceSpec {
  key: GlanceKey;
  id: string;
  /** North-star metrics are labelled as such: ISS-649 named exactly two. */
  northStar?: boolean;
  format: (v: number | null) => string;
  /** Which direction of `deltaPct` is the good one. */
  betterWhen: "up" | "down";
}

const GLANCE: GlanceSpec[] = [
  {
    key: "leadTimeMinutes",
    id: "G1",
    northStar: true,
    format: formatMinutes,
    betterWhen: "down",
  },
  {
    key: "interventionsPerClosed",
    id: "G2",
    northStar: true,
    format: formatRatio,
    betterWhen: "down",
  },
  {
    key: "costPerClosedUsd",
    id: "G3",
    format: formatUsd,
    betterWhen: "down",
  },
  {
    key: "successRatePct",
    id: "G4",
    format: formatPercent,
    betterWhen: "up",
  },
  {
    key: "signupsWindow",
    id: "G5",
    format: formatCount,
    betterWhen: "up",
  },
];

function Delta({ metric, betterWhen }: { metric: AdminGlanceMetric; betterWhen: "up" | "down" }) {
  const t = useCopy();
  const text = formatDelta(metric.deltaPct);
  if (!text) return <span className="fg-caption">{t("operator.kpi.noBaseline")}</span>;
  const rising = (metric.deltaPct ?? 0) > 0;
  const good = rising === (betterWhen === "up");
  return (
    <span
      className="font-mono font-semibold"
      style={{ fontSize: "var(--text-12)", color: good ? TONE_META.success.fg : TONE_META.attention.fg }}
    >
      {text}
    </span>
  );
}

export function GlanceCardsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-5">
      {GLANCE.map((g) => (
        <PageSection key={g.id} className="py-3.5">
          <Skeleton variant="text" className="w-24" />
          <Skeleton className="mt-2 h-6 w-14" />
          <Skeleton className="mt-3 h-5 w-full" />
        </PageSection>
      ))}
    </div>
  );
}

export function GlanceCards({ glance }: { glance: AdminOverview["glance"] }) {
  const t = useCopy();
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-5">
      {GLANCE.map((spec) => {
        const metric = glance[spec.key];
        return (
          <PageSection key={spec.id} className="flex flex-col gap-2 py-3.5">
            <div className="flex items-baseline gap-2">
              <span className="fg-overline">{spec.id}</span>
              {spec.northStar && <span className="fg-caption text-accent">{t("operator.glance.northStar")}</span>}
            </div>
            <span className="fg-label">{t(`operator.glance.${spec.key}`)}</span>
            <div className="flex items-end justify-between gap-2">
              <span className="fg-h2 font-mono tabular-nums">
                {metric.value == null ? NO_VALUE : spec.format(metric.value)}
              </span>
              <Delta metric={metric} betterWhen={spec.betterWhen} />
            </div>
            <Sparkline points={metric.spark} width={140} height={22} className="w-full" />
          </PageSection>
        );
      })}
    </div>
  );
}
