import { SCHEDULE_KINDS } from '@forge/contracts/schedules';
import { relations, sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';

export const scheduleKinds = SCHEDULE_KINDS;

export type ScheduleKind = (typeof scheduleKinds)[number];

export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    cron: text('cron').notNull(),
    // ISS-618 — nullable: a script-kind schedule has no prompt at all.
    // App-layer validation enforces prompt-required for kind='prompt'.
    prompt: text('prompt'),
    enabled: boolean('enabled').notNull().default(true),
    targetProjectSlug: text('target_project_slug'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    metadata: jsonb('metadata'),
    params: jsonb('params'),
    kind: text('kind', { enum: scheduleKinds }).notNull().default('prompt'),
    script: text('script'),
    /**
     * Who a cron firing acts as (ISS-30): whoever last saved the schedule. Null once that account
     * is gone, which refuses the run by name until an admin saves it again.
     */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectEnabledIdx: index('schedules_project_enabled_idx').on(t.projectId, t.enabled),
    nextRunAtIdx: index('schedules_next_run_at_idx').on(t.nextRunAt).where(sql`enabled = true`),
  }),
);

export const schedulesRelations = relations(schedules, ({ one }) => ({
  project: one(projects, { fields: [schedules.projectId], references: [projects.id] }),
}));
