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
