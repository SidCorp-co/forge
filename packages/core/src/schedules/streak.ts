// the one failing-streak rule (design automation rev 1, step streak; ISS-112 settled the fires,
// ISS-114 moved the rule out of alert A5): admin alert A5 and the automation read model both read a
// schedule's streak here and judge it with `streakFails`, so an admin and a member see one answer

import { SCHEDULE_RUN_STREAK_SKIP_REASONS } from '@forge/contracts/schedules';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/** How recently a streak's last counted fire must have run for the streak to stand. */
const SCHEDULE_ACTIVE_WINDOW_HOURS = 24 * 8;

export interface ScheduleStreak {
  scheduleId: string;
  /** Trailing failed fires; a skip counts only for a reason in SCHEDULE_RUN_STREAK_SKIP_REASONS. */
  streak: number;
  /** The newest fire the streak counted, success or failure. */
  lastCountedAt: Date;
  /** The oldest fire of the trailing streak; null when the streak is 0. */
  streakStartedAt: Date | null;
}

type StreakRow = {
  schedule_id: string;
  streak: number;
  last_counted_at: string | Date;
  streak_started_at: string | Date | null;
};

const STREAK_SKIP_REASONS_SQL = sql.join(
  SCHEDULE_RUN_STREAK_SKIP_REASONS.map((r) => sql`${r}`),
  sql`, `,
);

const at = (v: string | Date): Date => (v instanceof Date ? v : new Date(v));

/** Each schedule's streak, across every project or within one, holding at least `minStreak`. */
export async function readScheduleStreaks(
  scope: { projectId?: string; scheduleId?: string; minStreak?: number } = {},
): Promise<ScheduleStreak[]> {
  const project = scope.projectId ? sql`AND project_id = ${scope.projectId}` : sql``;
  const schedule = scope.scheduleId ? sql`AND schedule_id = ${scope.scheduleId}` : sql``;
  const rows = await db.execute<StreakRow>(sql`
    WITH counted AS (
      SELECT schedule_id, status = 'success' AS succeeded, created_at,
             row_number() OVER (PARTITION BY schedule_id ORDER BY created_at DESC, id DESC) AS rn
      FROM schedule_runs
      WHERE (status IN ('success', 'failed')
             OR (status = 'skipped' AND reason IN (${STREAK_SKIP_REASONS_SQL})))
        ${project} ${schedule}
    ),
    heads AS (
      SELECT schedule_id,
             coalesce(min(rn) FILTER (WHERE succeeded) - 1, count(*))::int AS streak,
             max(created_at) AS last_counted_at
      FROM counted
      GROUP BY schedule_id
    )
    SELECT h.schedule_id::text AS schedule_id, h.streak, h.last_counted_at,
           (SELECT min(c.created_at) FROM counted c
             WHERE c.schedule_id = h.schedule_id AND c.rn <= h.streak) AS streak_started_at
    FROM heads h
    WHERE h.streak >= ${scope.minStreak ?? 0}
  `);
  return rows.map((r) => ({
    scheduleId: r.schedule_id,
    streak: Number(r.streak),
    lastCountedAt: at(r.last_counted_at),
    streakStartedAt: r.streak_started_at === null ? null : at(r.streak_started_at),
  }));
}

/**
 * Whether a streak puts its schedule at failing: enabled, at or above the threshold, and counted
 * within the active window. A streak clears on the next successful fire, never on an edit.
 */
export function streakFails(
  streak: Pick<ScheduleStreak, 'streak' | 'lastCountedAt'> | null,
  schedule: { enabled: boolean },
  failStreak: number,
  now: Date,
): boolean {
  if (!streak || !schedule.enabled) return false;
  if (streak.streak < failStreak) return false;
  return now.getTime() - streak.lastCountedAt.getTime() <= SCHEDULE_ACTIVE_WINDOW_HOURS * 3_600_000;
}
