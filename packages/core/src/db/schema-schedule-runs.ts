import {
  SCHEDULE_RUN_SKIP_REASONS,
  SCHEDULE_RUN_STATUSES,
  SCHEDULE_RUN_TRIGGERS,
} from '@forge/contracts/schedules';
import { relations, sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agentSessions, pipelineRuns, projects, schedules } from './schema.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// One row per fire of every kind (design automation, steps tick, route, skipped, settle and
// fires_table). A prompt fire carries the session it started; a fire that ran nothing says why in
// `reason` or `refusal`. A schedule's last status is its newest fire, read, never stored.
export const scheduleRuns = pgTable(
  'schedule_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    trigger: text('trigger', { enum: SCHEDULE_RUN_TRIGGERS }).notNull(),
    status: text('status', { enum: SCHEDULE_RUN_STATUSES }).notNull(),
    reason: text('reason', { enum: SCHEDULE_RUN_SKIP_REASONS }),
    refusal: text('refusal'),
    disposition: text('disposition'),
    sessionId: uuid('session_id').references(() => agentSessions.id, { onDelete: 'set null' }),
    pipelineRunId: uuid('pipeline_run_id').references(() => pipelineRuns.id, {
      onDelete: 'set null',
    }),
    output: text('output'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scheduleCreatedIdx: index('schedule_runs_schedule_created_idx').on(t.scheduleId, t.createdAt),
    sessionUq: uniqueIndex('schedule_runs_session_uq')
      .on(t.sessionId)
      .where(sql`session_id IS NOT NULL`),
    triggerChk: check(
      'schedule_runs_trigger_chk',
      sql`${t.trigger} IN (${inList(SCHEDULE_RUN_TRIGGERS)})`,
    ),
    statusChk: check(
      'schedule_runs_status_chk',
      sql`${t.status} IN (${inList(SCHEDULE_RUN_STATUSES)})`,
    ),
    reasonChk: check(
      'schedule_runs_reason_chk',
      sql`(${t.status} = 'skipped') = (${t.reason} IS NOT NULL) AND (${t.reason} IS NULL OR ${t.reason} IN (${inList(SCHEDULE_RUN_SKIP_REASONS)}))`,
    ),
    refusalChk: check(
      'schedule_runs_refusal_chk',
      sql`${t.refusal} IS NULL OR (${t.status} IN ('failed', 'skipped') AND ${t.refusal} ~ '^[A-Z][A-Z0-9_]*$')`,
    ),
    finishedChk: check(
      'schedule_runs_finished_chk',
      sql`(${t.status} = 'running') = (${t.finishedAt} IS NULL)`,
    ),
  }),
);

export const scheduleRunsRelations = relations(scheduleRuns, ({ one }) => ({
  schedule: one(schedules, { fields: [scheduleRuns.scheduleId], references: [schedules.id] }),
  project: one(projects, { fields: [scheduleRuns.projectId], references: [projects.id] }),
  session: one(agentSessions, {
    fields: [scheduleRuns.sessionId],
    references: [agentSessions.id],
  }),
}));
