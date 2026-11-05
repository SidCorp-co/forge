import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { feedback } from './schema-feedback.js';
import { issues } from './schema-issues.js';
import { scheduleRuns } from './schema-schedule-runs.js';

/**
 * One forge-beta issue and what it was ported to (ISS-923): a forge-dev issue (a twin, ported before
 * ISS-982), or a Feedback item of the same-slug project, never both; with the dev status last
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
    /** The dev issue a twin was ported to; null where the beta issue was ported as Feedback. */
    devIssueId: uuid('dev_issue_id').references(() => issues.id, { onDelete: 'cascade' }),
    /** The Feedback item the beta issue was ported as (ISS-982); null on a twin. */
    devFeedbackId: uuid('dev_feedback_id').references(() => feedback.id, { onDelete: 'cascade' }),
    /**
     * The triage outcome of a Feedback pair already commented on beta (a requirement route, an
     * answer, a decline, a duplicate), so each is commented once; null where none was.
     */
    feedbackTold: text('feedback_told'),
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
    /**
     * The refusal a close by release met on beta (ISS-1005: the mirror records the dev release that
     * closed the twin on beta, which closes the beta issue), commented on the beta issue once; null
     * where none was. The close stays owed and is tried at every fire until beta stands closed.
     */
    closeRefused: text('close_refused'),
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
    devFeedbackIdx: index('beta_port_pairs_dev_feedback_idx').on(t.devFeedbackId),
    devSideChk: check(
      'beta_port_pairs_dev_side_chk',
      sql`(${t.devIssueId} IS NULL) <> (${t.devFeedbackId} IS NULL)`,
    ),
  }),
);
