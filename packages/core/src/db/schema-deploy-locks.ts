/** One deploy reaches one environment at a time (ISS-1279). The primary key refuses a second
 *  taker; `expires_at`, read against the database's clock, keeps a dead holder temporary. */

import { relations, sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { pipelineRuns } from './schema-pipeline.js';
import { projects } from './schema-projects.js';

const ENVIRONMENT_CHK = sql`environment ~ '^[a-z][a-z0-9-]{0,62}$'`;

export const deployLocks = pgTable(
  'deploy_locks',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** A project-document environment name: the box reached, not the binding that reaches it. */
    environment: text('environment').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** What a reclaim displaced. No foreign key: it must outlive the run it names. */
    reclaimedFromRunId: uuid('reclaimed_from_run_id'),
    reclaimedAt: timestamp('reclaimed_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.environment] }),
    byRun: index('deploy_locks_run_idx').on(t.runId),
    environmentChk: check('deploy_locks_environment_chk', ENVIRONMENT_CHK),
  }),
);

/** A refused acquire, one row per run and environment: what the run's `deploy_locked` wait reads,
 *  so a release reads it only when its own acquire was refused. `holder_*` is null where the
 *  refusal could read no holder (an acquisition in flight); no foreign key on the holder, which the
 *  row must outlive. A later acquire by the same run that takes the environment deletes the row. */
export const deployLockRefusals = pgTable(
  'deploy_lock_refusals',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    environment: text('environment').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    holderRunId: uuid('holder_run_id'),
    holderSubject: text('holder_subject'),
    holderAcquiredAt: timestamp('holder_acquired_at', { withTimezone: true }),
    /** The holder's `expires_at` at the refusal: until when the refusal stands. */
    refusedUntil: timestamp('refused_until', { withTimezone: true }),
    refusedAt: timestamp('refused_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.environment] }),
    byProject: index('deploy_lock_refusals_project_idx').on(t.projectId),
  }),
);

export const deployLocksRelations = relations(deployLocks, ({ one }) => ({
  project: one(projects, { fields: [deployLocks.projectId], references: [projects.id] }),
  run: one(pipelineRuns, { fields: [deployLocks.runId], references: [pipelineRuns.id] }),
}));
