import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';
import { actorAgencies } from './schema-vocabulary.js';

/**
 * A weekly summary of What's new, written by an agent over one ISO week's entries of the platform
 * project. One per project and week: a second write for the week replaces the first.
 */
export const whatsNewDigests = pgTable(
  'whats_new_digests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    week: text('week').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    entryKeys: text('entry_keys').array().notNull(),
    writtenBy: uuid('written_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    writtenAgency: text('written_agency', { enum: actorAgencies }).notNull(),
    writtenAt: timestamp('written_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('whats_new_digests_project_week_uq').on(t.projectId, t.week),
    check('whats_new_digests_week_chk', sql`${t.week} ~ '^[0-9]{4}-W[0-9]{2}$'`),
    check('whats_new_digests_agency_chk', sql`${t.writtenAgency} IN ('human', 'agent')`),
    check('whats_new_digests_entry_keys_chk', sql`cardinality(${t.entryKeys}) > 0`),
  ],
);
