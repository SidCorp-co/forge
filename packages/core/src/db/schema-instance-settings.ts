import { sql } from 'drizzle-orm';
import { check, integer, pgTable, smallint, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { projects } from './schema-projects.js';

/**
 * What this Forge instance says about itself, one row at most (REQ-47). Nothing in it is guessed: no
 * row is an instance that has said nothing, and a setting it has not said is null. `revision` moves
 * on every write, so a write sent against a revision that has since moved is refused by name.
 */
export const instanceSettings = pgTable(
  'instance_settings',
  {
    id: smallint('id').primaryKey().default(1),
    /** The project feedback about Forge itself is filed into (`forge_feedback`); null, filing is refused. */
    forgeHomeProjectId: uuid('forge_home_project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    revision: integer('revision').notNull().default(1),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    singleChk: check('instance_settings_single_chk', sql`${t.id} = 1`),
    revisionChk: check('instance_settings_revision_chk', sql`${t.revision} >= 1`),
  }),
);
