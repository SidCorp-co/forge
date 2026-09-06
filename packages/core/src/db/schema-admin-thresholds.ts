/**
 * `admin_thresholds` — the Ops Console's Tier 1 thresholds and its spend
 * ceiling, as operator policy rather than redeploy-only constants (ISS-654).
 *
 * Split out of `schema.ts` for the reason `schema-activity.ts` states: that
 * file is frozen far over the 500-line budget and the `form` axis declares
 * `improves=down`, so a new table cannot land there without an amnesty the gate
 * refuses. `drizzle.config.ts` and `db/client.ts` each name this file.
 */

import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { ADMIN_THRESHOLD_DEFAULTS } from '../admin/types.js';
import { users } from './schema.js';

// cm:why one GLOBAL row rather than an `app_config` row — that table is keyed `project_id UNIQUE` and the Ops Console is cross-tenant, so per-project policy cannot express a fleet-wide threshold
// cm:guard exactly one row, pinned by the `id = 'singleton'` check — every reader takes the first row it finds and every writer upserts on the primary key, so a second row would make the effective policy depend on scan order.
export const ADMIN_THRESHOLDS_ID = 'singleton';

// cm:edge lockstep -> packages/core/src/admin/types.ts — every default below is read from ADMIN_THRESHOLD_DEFAULTS rather than written twice, so the empty table and `readThresholds`' fallback are the same numbers by construction.
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
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // cm:guard the literal is written INTO the template, never interpolated — drizzle turns `${ADMIN_THRESHOLDS_ID}` into a bind placeholder and drizzle-kit emits `CHECK (id = $1)`, which the migrator applies verbatim and postgres rejects.
    singletonCk: check('admin_thresholds_singleton_ck', sql`${t.id} = 'singleton'`),
  }),
);
