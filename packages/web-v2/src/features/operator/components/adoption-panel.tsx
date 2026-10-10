"use client";

import { PageSection, PageSectionBody, PageSectionHeader, PageSectionTitle, EmptyState, Skeleton } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { formatCount, formatWeek } from "../format";
import type { AdminAdoptionBucket } from "../types";

const H = 120;
const PAD = 4;

export function AdoptionPanelSkeleton() {
  const t = useCopy();
  return (
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>{t("operator.adoption.title")}</PageSectionTitle>
      </PageSectionHeader>
      <PageSectionBody>
        <Skeleton className="h-30 w-full" />
      </PageSectionBody>
    </PageSection>
  );
}

/** Cumulative users as a line, active workspaces as bars behind it. Both are
    read off the same weekly buckets, so one x-axis serves both. */
export function AdoptionChart({ buckets }: { buckets: readonly AdminAdoptionBucket[] }) {
  const t = useCopy();
  if (buckets.length === 0) {
    return (
      <PageSection>
        <PageSectionHeader>
          <PageSectionTitle>{t("operator.adoption.title")}</PageSectionTitle>
        </PageSectionHeader>
        <PageSectionBody>
          <EmptyState message={t("operator.adoption.empty")} mascot={false} />
        </PageSectionBody>
      </PageSection>
    );
  }

  const last = buckets[buckets.length - 1];
  const width = Math.max(buckets.length - 1, 1) * 40;
  const maxUsers = Math.max(...buckets.map((b) => b.cumulativeUsers), 1);
  const maxWorkspaces = Math.max(...buckets.map((b) => b.activeWorkspaces), 1);
  const stepX = width / Math.max(buckets.length - 1, 1);
  const usable = H - PAD * 2;
  const y = (v: number, max: number) => PAD + usable - (v / max) * usable;

  const line = buckets
    .map((b, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(2)},${y(b.cumulativeUsers, maxUsers).toFixed(2)}`)
    .join(" ");

  return (
    <PageSection>
      <PageSectionHeader>
        <PageSectionTitle>{t("operator.adoption.title")}</PageSectionTitle>
        <span className="fg-caption">
          {t("operator.adoption.totals", { users: formatCount(last.cumulativeUsers), workspaces: formatCount(last.activeWorkspaces) })}
        </span>
      </PageSectionHeader>
      <PageSectionBody>
        <svg
          viewBox={`0 0 ${width} ${H}`}
          className="h-30 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label={t("operator.adoption.chart", { weeks: buckets.length, users: last.cumulativeUsers, workspaces: last.activeWorkspaces })}
        >
          {buckets.map((b, i) => {
            const barTop = y(b.activeWorkspaces, maxWorkspaces);
            return (
              <rect
                key={b.bucketStart}
                x={Math.max(i * stepX - 6, 0)}
                y={barTop}
                width={12}
                height={Math.max(H - PAD - barTop, 0)}
                fill="var(--paper-200)"
              />
            );
          })}
          <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
        </svg>
        <ol className="mt-2 flex justify-between">
          {buckets.map((b) => (
            <li key={b.bucketStart} className="fg-caption font-mono">
              {formatWeek(b.bucketStart)}
            </li>
          ))}
        </ol>
      </PageSectionBody>
    </PageSection>
  );
}
