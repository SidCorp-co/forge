import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { projects } from './schema-projects.js';

/**
 * What the source host answered about a served commit and a commit a verdict was judged at: whether
 * the served one descends from it, and where it does not, every file the two trees may differ in
 * (`release-batch/served-ancestry.ts`). Asked once, by the pass that reads what a project serves, so
 * a read answers from here and asks no host (ISS-774), and a deploy empties nothing. The same pass
 * asks whether a shipped release's commit holds the landing of an issue judged there, and the other
 * way where it does not, and a door that asked the host keeps a `holds` (ISS-1079): `served_commit`
 * is then the later commit and `judged_commit` the earlier. Ancestry between two named commits never
 * changes, so a row is never updated; a host that did not answer writes none.
 */
export const servedAncestry = pgTable(
  'served_ancestry',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The whole commit an environment of the project was read serving, or the later of a pair, lower case. */
    servedCommit: text('served_commit').notNull(),
    /** The whole commit a verdict on the project was judged at, or the earlier of a pair, lower case. */
    judgedCommit: text('judged_commit').notNull(),
    carried: boolean('carried').notNull(),
    /** Where not carried, the files the two trees may differ in; null where carried. */
    differsIn: text('differs_in').array(),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.servedCommit, t.judgedCommit] }),
    wholeChk: check(
      'served_ancestry_whole_chk',
      sql`${t.servedCommit} ~ '^[0-9a-f]{40}$' AND ${t.judgedCommit} ~ '^[0-9a-f]{40}$'`,
    ),
    differsChk: check(
      'served_ancestry_differs_chk',
      sql`(${t.carried} AND ${t.differsIn} IS NULL) OR (NOT ${t.carried} AND ${t.differsIn} IS NOT NULL)`,
    ),
  }),
);
