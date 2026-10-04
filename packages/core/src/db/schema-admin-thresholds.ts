import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema.js';

/**
 * ISS-654 — the Tier 1 thresholds and the spend ceiling, as operator policy.
 *
 * `spendCeilingUsdDay` is null when no ceiling is set; every other field is
 * always present, so a reader never branches on absence.
 */
export interface AdminThresholds {
  stuckJobSeconds: number;
  runnerStarvedSeconds: number;
  spendCeilingUsdDay: number | null;
  spendSpikeMultiple: number;
  scheduleFailStreak: number;
  deliveryFailRatePct: number;
  interventionLabels: string[];
  ghostRunnerOfflineDays: number;
  sentryMinEventCount: number;
  sentryMinUserCount: number;
}

export const SENTRY_THRESHOLD_MIN = 1;
export const SENTRY_THRESHOLD_MAX = 1_000_000;

export const ADMIN_THRESHOLD_DEFAULTS: AdminThresholds = {
  stuckJobSeconds: 600,
  runnerStarvedSeconds: 300,
  spendCeilingUsdDay: null,
  spendSpikeMultiple: 2.5,
  scheduleFailStreak: 2,
  deliveryFailRatePct: 20,
  interventionLabels: ['kernel-hardening', 'onboarding'],
  ghostRunnerOfflineDays: 14,
  sentryMinEventCount: 10,
  sentryMinUserCount: 2,
};

export const ADMIN_THRESHOLDS_ID = 'singleton';

export const adminThresholds = pgTable(
  'admin_thresholds',
  {
    id: text('id').primaryKey().default(ADMIN_THRESHOLDS_ID),
    stuckJobSeconds: integer('stuck_job_seconds')
      .notNull()
      .default(ADMIN_THRESHOLD_DEFAULTS.stuckJobSeconds),
    runnerStarvedSeconds: integer('runner_starved_seconds')
      .notNull()
      .default(ADMIN_THRESHOLD_DEFAULTS.runnerStarvedSeconds),
    /** NULL = no ceiling; A4 then classifies on the ratio arm alone, which is today's behaviour. */
    spendCeilingUsdDay: real('spend_ceiling_usd_day'),
    spendSpikeMultiple: real('spend_spike_multiple')
      .notNull()
      .default(ADMIN_THRESHOLD_DEFAULTS.spendSpikeMultiple),
    scheduleFailStreak: integer('schedule_fail_streak')
      .notNull()
      .default(ADMIN_THRESHOLD_DEFAULTS.scheduleFailStreak),
    deliveryFailRatePct: integer('delivery_fail_rate_pct')
      .notNull()
      .default(ADMIN_THRESHOLD_DEFAULTS.deliveryFailRatePct),
    /** Label NAMES, not ids — labels are project-scoped and the console is cross-tenant. */
    interventionLabels: jsonb('intervention_labels')
      .notNull()
      .$type<string[]>()
      .default(ADMIN_THRESHOLD_DEFAULTS.interventionLabels),
    ghostRunnerOfflineDays: integer('ghost_runner_offline_days')
      .notNull()
      .default(ADMIN_THRESHOLD_DEFAULTS.ghostRunnerOfflineDays),
    sentryMinEventCount: integer('sentry_min_event_count')
      .notNull()
      .default(ADMIN_THRESHOLD_DEFAULTS.sentryMinEventCount),
    sentryMinUserCount: integer('sentry_min_user_count')
      .notNull()
      .default(ADMIN_THRESHOLD_DEFAULTS.sentryMinUserCount),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    singletonCk: check('admin_thresholds_singleton_ck', sql`${t.id} = 'singleton'`),
    sentryEventCountCk: check(
      'admin_thresholds_sentry_min_event_count_ck',
      sql`${t.sentryMinEventCount} >= ${sql.raw(String(SENTRY_THRESHOLD_MIN))} AND ${t.sentryMinEventCount} <= ${sql.raw(String(SENTRY_THRESHOLD_MAX))}`,
    ),
    sentryUserCountCk: check(
      'admin_thresholds_sentry_min_user_count_ck',
      sql`${t.sentryMinUserCount} >= ${sql.raw(String(SENTRY_THRESHOLD_MIN))} AND ${t.sentryMinUserCount} <= ${sql.raw(String(SENTRY_THRESHOLD_MAX))}`,
    ),
  }),
);
