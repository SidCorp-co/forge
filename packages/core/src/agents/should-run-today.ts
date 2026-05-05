import type { AgentSchedule } from '../db/schema.js';

// All checks are UTC; the daily cron fires at `0 0 * * *` UTC, so "Monday" =
// UTC Monday and "day 1" = UTC day-of-month — operator timezone is irrelevant.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Anchor for biweekly parity: Monday 2024-01-01 (UTC) — week 0. Any later
// Monday's index is `floor((midnight - anchor) / 7d)`, and "even week" means
// `index % 2 === 0`.
const BIWEEKLY_EPOCH_MONDAY_UTC = Date.UTC(2024, 0, 1);

export function shouldRunToday(schedule: AgentSchedule, date: Date): boolean {
  if (schedule === 'off') return false;
  if (schedule === 'monthly') return date.getUTCDate() === 1;

  const isMonday = date.getUTCDay() === 1;
  if (!isMonday) return false;
  if (schedule === 'weekly') return true;

  if (schedule === 'biweekly') {
    const midnightUtc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const weekIndex = Math.floor((midnightUtc - BIWEEKLY_EPOCH_MONDAY_UTC) / (7 * MS_PER_DAY));
    return weekIndex % 2 === 0;
  }

  return false;
}
