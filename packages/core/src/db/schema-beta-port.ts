import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { issues } from './schema-issues.js';
import { scheduleRuns } from './schema-schedule-runs.js';

/**
 * One forge-beta issue and the forge-dev issue it was ported to (ISS-923), with the dev status last
 * mirrored onto beta. A beta issue is ported at most once (the unique index is the third guard
 * beside the beta comment and the dev issue's first line), and a mirror move is tried once per dev
 * status: `last_tried_status` is written whatever beta answered, `beta_reached` names the status beta
 * stood at after the try, and `last_mirrored_status` only a dev status whose move beta took.
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
    /** The dev status last tried onto beta, taken or not; null on a pair tried under the old rule. */
    lastTriedStatus: text('last_tried_status'),
    /** The beta status beta stood at after that try: its target, the nearest legal one, or unmoved. */
    betaReached: text('beta_reached'),
    /**
     * When a fire wrote beta's body onto a dev issue ported with only its provenance line, or found
     * beta's body empty; null where no backfill was made (ISS-923: the first fire read no bodies).
     */
    bodyBackfilledAt: timestamp('body_backfilled_at', { withTimezone: true }),
    /** The fire that made that backfill. */
    bodyBackfillFireId: uuid('body_backfill_fire_id').references(() => scheduleRuns.id, {
      onDelete: 'set null',
    }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    betaIssueUq: uniqueIndex('beta_port_pairs_beta_issue_uq').on(t.betaIssueId),
    devIssueIdx: index('beta_port_pairs_dev_issue_idx').on(t.devIssueId),
  }),
);
