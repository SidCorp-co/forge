/**
 * `project_facts_migration_backup` — the rollback source for ISS-1048's move of project prose
 * out of `projects.agent_config` into `knowledge_entries`.
 *
 * Migration 0254 writes both original maps here verbatim BEFORE it strips them, because the
 * knowledge rows cannot serve as the way back: the inverse of the copy cannot tell a migrated
 * row from an entry that was always a knowledge entry, and cannot recover a body edited after
 * the cutover. Restoring is one statement over this table; prose written or edited in
 * `knowledge_entries` after the cutover stays there and is not copied back.
 *
 * Nothing in TypeScript reads or writes this table — the migration owns both halves. It is
 * declared here so drizzle's next `db:generate` diffs against a schema that knows it exists;
 * a table present in the database and absent from the schema is emitted as a `DROP TABLE`.
 *
 * Split out of `schema.ts` for the reason `schema-run-ledger.ts` states: that file is frozen
 * far over the file budget, so a new table cannot land there without the size gate going red.
 */

import { jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { projects } from './schema.js';

export const projectFactsMigrationBackup = pgTable('project_facts_migration_backup', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  projectFacts: jsonb('project_facts').notNull().default({}),
  projectFactsConfig: jsonb('project_facts_config').notNull().default({}),
  migratedAt: timestamp('migrated_at', { withTimezone: true }).notNull().defaultNow(),
});
