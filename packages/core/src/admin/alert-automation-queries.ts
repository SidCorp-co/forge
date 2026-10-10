// The alerts read from automations and the outbox (ISS-652 A5-A6). An id list is bound via
// `sql.join(...IN (...))` or `inArray`, never `= ANY(${jsArray}::uuid[])`, which drizzle expands
// as a malformed record tuple.

import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { schedules } from '../db/schema.js';
import type { AdminThresholds } from '../lib/admin-thresholds.js';
import { tallyDeadDeliveries } from '../outbox/index.js';
import { readScheduleStreaks, type ScheduleStreak, streakFails } from '../schedules/index.js';
import { type AlertReading, ENTITY_LIMIT, oldestIso, type PgTimestamp } from './alert-reading.js';
import {
  classifyDeliveryFailRate,
  classifyScheduleStreak,
  DELIVERY_MIN_SAMPLE,
  STATUS_RANK,
  worstStatus,
} from './alert-rules.js';
import type { AdminAlertStatus } from './types.js';

type ScheduleStreakRow = {
  schedule_id: string;
  name: string;
  streak: number;
  streak_started_at: PgTimestamp | null;
};

async function failingScheduleRows(
  streaks: readonly ScheduleStreak[],
  failStreak: number,
  now: Date,
): Promise<ScheduleStreakRow[]> {
  if (streaks.length === 0) return [];
  const named = await db
    .select({ id: schedules.id, name: schedules.name, enabled: schedules.enabled })
    .from(schedules)
    .where(
      inArray(
        schedules.id,
        streaks.map((s) => s.scheduleId),
      ),
    );
  const byId = new Map(named.map((n) => [n.id, n]));
  return streaks
    .flatMap((s) => {
      const schedule = byId.get(s.scheduleId);
      if (!schedule || !streakFails(s, schedule, failStreak, now)) return [];
      return [
        {
          schedule_id: s.scheduleId,
          name: schedule.name,
          streak: s.streak,
          streak_started_at: s.streakStartedAt,
        },
      ];
    })
    .sort((a, b) => b.streak - a.streak);
}

type DeliveryFailRow = {
  binding_id: string;
  provider: string;
  project_id: string;
  project_slug: string;
  failed: number;
  total: number;
  oldest_failed_at: PgTimestamp | null;
};

/** A5 — two contributors combined into one alert: schedule fail-streaks and integration-delivery fail-rates. */
export async function alertAutomationFailing(
  thresholds: AdminThresholds,
  now: Date,
): Promise<AlertReading> {
  const [streaks, deliveryRows] = await Promise.all([
    readScheduleStreaks({ minStreak: thresholds.scheduleFailStreak }),
    db.execute<DeliveryFailRow>(sql`
      SELECT b.id AS binding_id, b.provider, b.project_id, p.slug AS project_slug,
             count(*) FILTER (WHERE d.status = 'failed')::int AS failed,
             count(*)::int AS total,
             min(d.created_at) FILTER (WHERE d.status = 'failed') AS oldest_failed_at
      FROM integration_bindings b
      JOIN integration_deliveries d ON d.binding_id = b.id AND d.direction = 'outbound'
      JOIN projects p ON p.id = b.project_id
      WHERE d.status IN ('ok', 'failed')
        AND d.created_at >= now() - interval '1 hour'
      GROUP BY b.id, b.provider, b.project_id, p.slug
      HAVING count(*) >= ${DELIVERY_MIN_SAMPLE}
    `),
  ]);

  const scheduleRows = await failingScheduleRows(streaks, thresholds.scheduleFailStreak, now);
  const scheduleContributors = scheduleRows.map((r) => ({
    entity: {
      ref: r.schedule_id,
      kind: 'schedule' as const,
      label: `${r.name} · ${r.streak} in a row`,
    },
    status: classifyScheduleStreak(r.streak, thresholds.scheduleFailStreak),
    since: r.streak_started_at,
  }));
  const deliveryContributors = deliveryRows
    .map((r) => ({
      entity: {
        ref: r.binding_id,
        kind: 'integration_binding' as const,
        label: `${r.provider} · ${r.project_slug} · ${r.failed}/${r.total} failed`,
      },
      status: classifyDeliveryFailRate(r.failed, r.total, thresholds.deliveryFailRatePct),
      since: r.oldest_failed_at,
    }))
    .filter((r) => r.status !== 'ok');

  const contributors = [...scheduleContributors, ...deliveryContributors].sort(
    (a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status],
  );
  const status = contributors.reduce(
    (acc, c) => worstStatus(acc, c.status),
    'ok' as AdminAlertStatus,
  );
  const since = oldestIso(contributors.map((c) => c.since));

  return {
    id: 'A5',
    key: 'automation_failing',
    status,
    count: contributors.length,
    detail:
      contributors.length > 0
        ? `${contributors.length} automation${contributors.length === 1 ? '' : 's'} failing (schedules or integration deliveries)`
        : 'No automation failures',
    since,
    entities: contributors.slice(0, ENTITY_LIMIT).map((c) => c.entity),
  };
}

/**
 * A6 — outbox deliveries that ran out of attempts. Any dead delivery is crit: a reaction that will
 * not happen until somebody replays it (`POST /api/admin/outbox/deliveries/:did/replay`).
 */
export async function alertDeadDeliveries(): Promise<AlertReading> {
  const { count, oldestDeadAt, sample } = await tallyDeadDeliveries(ENTITY_LIMIT);
  return {
    id: 'A6',
    key: 'outbox_dead',
    status: count > 0 ? 'crit' : 'ok',
    count,
    detail:
      count > 0
        ? `${count} outbox deliver${count === 1 ? 'y' : 'ies'} dead after every retry`
        : 'No dead outbox deliveries',
    since: oldestIso([oldestDeadAt]),
    entities: sample.map((d) => ({
      ref: d.id,
      kind: 'outbox_delivery',
      label: `${d.type} → ${d.consumer}`,
    })),
  };
}
