import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';

/**
 * One run of a registered report query (`reports/runs.ts:recordReportRun`): the query, its parsed
 * params, who asked and as what, the moment it read, and the frame it answered. A visual block names
 * a run by `id` and its figures must be that frame's. Kept until `expires_at`, 30 days after the
 * read, then swept (`reports/sweep.ts`); a read past it answers REPORT_RUN_EXPIRED.
 */
export const reportRuns = pgTable(
  'report_runs',
  {
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    queryId: text('query_id').notNull(),
    queryVersion: integer('query_version').notNull(),
    params: jsonb('params').notNull(),
    /** The project permission the query declared, held again by whoever reads the run back. */
    permission: text('permission').notNull(),
    actorKind: text('actor_kind', { enum: ['human', 'agent'] }).notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    frame: jsonb('frame').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index('report_runs_expires_idx').on(t.expiresAt),
    projectAsOfIdx: index('report_runs_project_as_of_idx').on(t.projectId, t.asOf),
    actorChk: check('report_runs_actor_chk', sql`${t.actorKind} IN ('human', 'agent')`),
    keepChk: check('report_runs_keep_chk', sql`${t.expiresAt} > ${t.asOf}`),
    paramsChk: check('report_runs_params_chk', sql`jsonb_typeof(${t.params}) = 'object'`),
    frameChk: check('report_runs_frame_chk', sql`jsonb_typeof(${t.frame}) = 'object'`),
  }),
);
