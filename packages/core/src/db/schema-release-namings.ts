import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';

/**
 * The name and summary a drafted release was given before it was cut (REQ-40 BC-14), one row per
 * project and version, owned by the `release-batch` domain. The cut that takes the version carries
 * the row onto its run's `metadata.naming` and deletes it, so a release's name lives in one place at
 * a time: here while it is a draft, on its run once it is cut.
 */
export const releaseDraftNamings = pgTable(
  'release_draft_namings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    name: text('name').notNull(),
    summary: text('summary').notNull(),
    namedBy: uuid('named_by').references(() => users.id, { onDelete: 'set null' }),
    namedAt: timestamp('named_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    versionUq: uniqueIndex('release_draft_namings_project_version_uq').on(t.projectId, t.version),
    projectIdx: index('release_draft_namings_project_idx').on(t.projectId),
  }),
);

export type ReleaseDraftNamingRow = typeof releaseDraftNamings.$inferSelect;
