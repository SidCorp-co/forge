"use client";

// Upcoming schedules card (ISS-379, AC#6) — next scheduled runs with cadence
// (cron) + next-run time + last-outcome chip. Data from `useSchedules`
// (`GET /api/schedules`, JWT/cookie auth via apiClient).
import { useRouter } from "next/navigation";
import { Button, MonoTag, StatusChip } from "@/design";
import { formatRelativeTime } from "@/features/projects/derive";
import { lastStatusToChip, type ScheduleRow } from "@/features/schedules/types";
import { DashboardSection, EmptyLine, RowList } from "./dashboard-section";

const MAX_ROWS = 5;

/** Compact "next run" label: relative time when scheduled, else paused/—. */
function nextRunLabel(row: ScheduleRow, now: number): string {
  if (!row.enabled) return "paused";
  if (!row.nextRunAt) return "—";
  return `in ${formatRelativeTime(row.nextRunAt, now).replace("just now", "moments")}`;
}

export function SchedulesCard({ rows, now, slug }: { rows: ScheduleRow[]; now: number; slug: string }) {
  const router = useRouter();
  const shown = rows.slice(0, MAX_ROWS);

  if (rows.length === 0) {
    // ISS-528: the empty line keeps its primary action — schedules are created on the project Automation screen.
    return (
      <EmptyLine
        title="Upcoming schedules"
        status="none"
        action={
          <Button variant="primary" size="sm" icon="plus" onClick={() => router.push(`/projects/${slug}/automation`)}>
            Create schedule
          </Button>
        }
      />
    );
  }

  return (
    <DashboardSection title="Upcoming schedules">
      <RowList>
        {shown.map((s) => {
          const chip = lastStatusToChip(s.lastStatus);
          return (
            <li key={s.id} className="flex items-center gap-2.5 py-2">
              <div className="min-w-0 flex-1">
                <p className="fg-body-sm truncate text-fg">{s.name}</p>
                <div className="mt-0.5 flex items-center gap-2">
                  <MonoTag>{s.cron}</MonoTag>
                  <span className="fg-caption text-subtle">{nextRunLabel(s, now)}</span>
                </div>
              </div>
              {chip ? (
                <StatusChip status={chip} size="sm" domain="session" />
              ) : (
                // No chip for this status (skipped, or one core adds later) is still a run
                // that happened: say its word, never "never run".
                <span className="fg-caption flex-none text-subtle">{s.lastStatus ?? "never run"}</span>
              )}
            </li>
          );
        })}
      </RowList>
    </DashboardSection>
  );
}
