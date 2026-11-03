import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { issues } from './schema-issues.js';

/**
 * One forge-beta issue and the forge-dev issue it was ported to (ISS-923), with the dev status last
 * mirrored onto beta. A beta issue is ported at most once (the unique index is the third guard
 * beside the beta comment and the dev issue's first line), and a mirror move is tried once per dev
 * status: `last_mirrored_status` is written whether beta took the move or refused it.
 */
export const betaPortPairs = pgTable(
  'beta_port_pairs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The beta issue's id on forge-beta: another instance's, so never a foreign key here. */
    betaIssueId: text('beta_issue_id').notNull(),
    betaKey: text('beta_key').notNull(),
    betaProjectSlug: text('beta_project_slug').notNull(),
    devIssueId: uuid('dev_issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    /** Null for a pair adopted from a hand port: its first mirror reads beta's own status. */
    lastMirroredStatus: text('last_mirrored_status'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    betaIssueUq: uniqueIndex('beta_port_pairs_beta_issue_uq').on(t.betaIssueId),
    devIssueIdx: index('beta_port_pairs_dev_issue_idx').on(t.devIssueId),
  }),
);
