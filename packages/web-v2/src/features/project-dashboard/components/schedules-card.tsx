// Upcoming schedules card (ISS-379, AC#6) — next scheduled runs with cadence
// (cron) + next-run time + last-outcome chip. Data from `useSchedules`
// (`GET /api/schedules`, JWT/cookie auth via apiClient).
import { Card, CardContent, Icon, MonoTag, StatusChip } from "@/design";
import { formatRelativeTime } from "@/features/projects/derive";
import { lastStatusToChip, type ScheduleRow } from "@/features/schedules/types";

const MAX_ROWS = 5;

/** Compact "next run" label: relative time when scheduled, else paused/—. */
function nextRunLabel(row: ScheduleRow, now: number): string {
  if (!row.enabled) return "paused";
  if (!row.nextRunAt) return "—";
  return `in ${formatRelativeTime(row.nextRunAt, now).replace("just now", "moments")}`;
}

export function SchedulesCard({ rows, now }: { rows: ScheduleRow[]; now: number }) {
  const shown = rows.slice(0, MAX_ROWS);

  return (
    <Card className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line-subtle px-5 py-3.5">
        <Icon name="calendar" size={16} className="text-subtle" />
        <h3 className="fg-h3">Upcoming schedules</h3>
      </div>
      <CardContent className="flex-1">
        {rows.length === 0 ? (
          <p className="fg-body-sm py-6 text-center text-muted">No schedules configured.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {shown.map((s) => {
              const chip = lastStatusToChip(s.lastStatus);
              return (
                <li key={s.id} className="flex items-center gap-2.5 rounded-md border border-line bg-surface px-2.5 py-2">
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
                    <span className="fg-caption flex-none text-subtle">never run</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
