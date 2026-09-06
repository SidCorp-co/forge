"use client";

import { Card, CardContent, CardHeader, CardTitle, EmptyState, Skeleton } from "@/design";
import { formatCount, formatWeek } from "../format";
import type { AdminAdoptionBucket } from "../types";

const H = 120;
const PAD = 4;

export function AdoptionPanelSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Adoption</CardTitle>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-[120px] w-full" />
      </CardContent>
    </Card>
  );
}

/** Cumulative users as a line, active workspaces as bars behind it. Both are
    read off the same weekly buckets, so one x-axis serves both. */
export function AdoptionPanel({ buckets }: { buckets: readonly AdminAdoptionBucket[] }) {
  if (buckets.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Adoption</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            title="No adoption history yet"
            message="Signups appear here once the first account is created."
            mascot={false}
          />
        </CardContent>
      </Card>
    );
  }

  const last = buckets[buckets.length - 1] as AdminAdoptionBucket;
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
    <Card>
      <CardHeader>
        <CardTitle>Adoption</CardTitle>
        <span className="fg-caption">
          {formatCount(last.cumulativeUsers)} users · {formatCount(last.activeWorkspaces)} active workspaces
        </span>
      </CardHeader>
      <CardContent>
        <svg
          viewBox={`0 0 ${width} ${H}`}
          className="h-[120px] w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Signup curve over ${buckets.length} weeks, ending at ${last.cumulativeUsers} users and ${last.activeWorkspaces} active workspaces`}
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
      </CardContent>
    </Card>
  );
}
