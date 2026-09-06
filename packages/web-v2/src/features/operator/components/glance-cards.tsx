"use client";

import { Card, Skeleton, Sparkline, Tooltip } from "@/design";
import { TONE_META } from "@/design/status";
import { formatDelta, formatMinutes, formatPercent, formatRatio, formatUsd, formatCount, NO_VALUE } from "../format";
import type { AdminGlanceMetric, AdminOverview } from "../types";

type GlanceKey = keyof AdminOverview["glance"];

interface GlanceSpec {
  key: GlanceKey;
  id: string;
  label: string;
  /** North-star metrics are labelled as such: ISS-649 named exactly two. */
  northStar?: boolean;
  format: (v: number | null) => string;
  /** Which direction of `deltaPct` is the good one. */
  betterWhen: "up" | "down";
  help: string;
}

const GLANCE: GlanceSpec[] = [
  {
    key: "leadTimeMinutes",
    id: "G1",
    label: "Lead time",
    northStar: true,
    format: formatMinutes,
    betterWhen: "down",
    help: "Median wait from an issue being filed to work starting on it.",
  },
  {
    key: "interventionsPerClosed",
    id: "G2",
    label: "Interventions / closed issue",
    northStar: true,
    format: formatRatio,
    betterWhen: "down",
    help: "Closed issues carrying a kernel-hardening or onboarding label, over all closed issues.",
  },
  {
    key: "costPerClosedUsd",
    id: "G3",
    label: "Cost / closed issue",
    format: formatUsd,
    betterWhen: "down",
    help: "Recorded spend over issues closed in the window.",
  },
  {
    key: "successRatePct",
    id: "G4",
    label: "Run success rate",
    format: formatPercent,
    betterWhen: "up",
    help: "Pipeline runs that completed, over those that reached any terminal status.",
  },
  {
    key: "signupsWindow",
    id: "G5",
    label: "New signups",
    format: formatCount,
    betterWhen: "up",
    help: "Users created in the window.",
  },
];

function Delta({ metric, betterWhen }: { metric: AdminGlanceMetric; betterWhen: "up" | "down" }) {
  const text = formatDelta(metric.deltaPct);
  if (!text) return <span className="fg-caption">no baseline</span>;
  const rising = (metric.deltaPct ?? 0) > 0;
  const good = rising === (betterWhen === "up");
  return (
    <span
      className="font-mono font-semibold"
      style={{ fontSize: 12, color: good ? TONE_META.success.fg : TONE_META.attention.fg }}
    >
      {text}
    </span>
  );
}

export function GlanceCardsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {GLANCE.map((g) => (
        <Card key={g.id} className="px-4 py-3.5">
          <Skeleton variant="text" className="w-24" />
          <Skeleton className="mt-2 h-6 w-14" />
          <Skeleton className="mt-3 h-5 w-full" />
        </Card>
      ))}
    </div>
  );
}

export function GlanceCards({ glance }: { glance: AdminOverview["glance"] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {GLANCE.map((spec) => {
        const metric = glance[spec.key];
        return (
          <Card key={spec.id} className="flex flex-col gap-2 px-4 py-3.5">
            <div className="flex items-baseline gap-2">
              <span className="fg-overline">{spec.id}</span>
              {spec.northStar && <span className="fg-caption text-accent">north-star</span>}
            </div>
            <Tooltip label={spec.help}>
              <button
                type="button"
                aria-label={`${spec.label} — ${spec.help}`}
                className="fg-label cursor-help rounded-sm text-left focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none"
              >
                {spec.label}
              </button>
            </Tooltip>
            <div className="flex items-end justify-between gap-2">
              <span className="fg-h2 font-mono tabular-nums">
                {metric.value == null ? NO_VALUE : spec.format(metric.value)}
              </span>
              <Delta metric={metric} betterWhen={spec.betterWhen} />
            </div>
            <Sparkline points={metric.spark} width={140} height={22} className="w-full" />
          </Card>
        );
      })}
    </div>
  );
}
