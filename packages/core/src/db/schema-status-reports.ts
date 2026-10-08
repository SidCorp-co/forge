import { STATUS_REPORT_PRODUCERS } from '@forge/contracts/status-reports';
import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';
import { schedules } from './schema-schedules.js';

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * One stored status report: the project status read (`project-status/read.ts:readProjectStatus`)
 * as it answered at `as_of`, kept as history. Immutable: trigger `status_report_guard` refuses any
 * change but the producer references going null when their rows are deleted. A sent report names the
 * schedule slot it answers in `period`, one report per (schedule, period).
 */
export const statusReports = pgTable(
  'status_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    producerKind: text('producer_kind', { enum: STATUS_REPORT_PRODUCERS }).notNull(),
    /** The person who saved it, or the schedule owner it was read as. */
    producedBy: uuid('produced_by').references(() => users.id, { onDelete: 'set null' }),
    scheduleId: uuid('schedule_id').references(() => schedules.id, { onDelete: 'set null' }),
    period: timestamp('period', { withTimezone: true }),
    asOf: timestamp('as_of', { withTimezone: true }).notNull(),
    days: integer('days').notNull(),
    report: jsonb('report').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectAsOfIdx: index('status_reports_project_as_of_idx').on(t.projectId, t.asOf),
    schedulePeriodUq: uniqueIndex('status_reports_schedule_period_uq')
      .on(t.scheduleId, t.period)
      .where(sql`schedule_id IS NOT NULL`),
    producerChk: check(
      'status_reports_producer_chk',
      sql`${t.producerKind} IN (${inList(STATUS_REPORT_PRODUCERS)}) AND (${t.producerKind} = 'schedule') = (${t.period} IS NOT NULL)`,
    ),
    daysChk: check('status_reports_days_chk', sql`${t.days} BETWEEN 1 AND 90`),
    reportChk: check('status_reports_report_chk', sql`jsonb_typeof(${t.report}) = 'object'`),
  }),
);

export const statusReportsRelations = relations(statusReports, ({ one }) => ({
  project: one(projects, { fields: [statusReports.projectId], references: [projects.id] }),
}));
