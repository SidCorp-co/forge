"use client";

// Right-hand context rail for the activity feed: today's event count + a
// per-stage legend (count by pipeline stage hue). Composes from @/design.
import { Card, CardContent } from "@/design";
import { todayStats } from "../derive";
import type { FeedRow } from "../types";

export function ActivityContextRail({ rows, now }: { rows: FeedRow[]; now: number }) {
  const stats = todayStats(rows, now);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent>
          <p className="fg-caption">Today</p>
          <p className="mt-1 font-mono text-2xl font-bold text-fg">{stats.total}</p>
          <p className="fg-caption mt-1">events across your projects</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <p className="fg-caption mb-3">By stage</p>
          <div className="space-y-2">
            {stats.byStage.map((s) => (
              <div key={s.stage} className="flex items-center gap-2.5">
                <span
                  className="inline-block size-2.5 flex-none rounded-pill"
                  style={{ background: s.color }}
                />
                <span className="fg-body-sm flex-1 capitalize text-muted">{s.label}</span>
                <span className="fg-caption font-mono">{s.count}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
