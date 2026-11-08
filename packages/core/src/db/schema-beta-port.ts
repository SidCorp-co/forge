import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { feedback } from './schema-feedback.js';
import { issues } from './schema-issues.js';
import { projects } from './schema-projects.js';
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

/**
 * Where a beta release taken by the port stands (ISS-988): every beta issue lacks a dev twin
 * (`no_twin`, reported once and never cut), its dev issues are not all at the release gate
 * (`waiting`), a dev release was cut for it (`requested`), or that release shipped or failed.
 */
export const BETA_PORT_RELEASE_STATES = [
  'no_twin',
  'waiting',
  'requested',
  'shipped',
  'failed',
] as const;
export type BetaPortReleaseState = (typeof BETA_PORT_RELEASE_STATES)[number];

/** One beta issue a beta release carries, as the port read it. */
export interface BetaReleaseIssue {
  id: string;
  key: string;
}

/**
 * One release pressed on a beta twin project and taken by the port (ISS-988, owner 2026-11-05: dev
 * runs it and writes the outcome back). A beta release is taken once (the unique index), and the
 * latest `beta_started_at` of a beta project is the port's high-water mark there. The dev release
 * the port cut for it is `dev_run_id`; once it ships or fails, the beta release is ended on beta
 * (`beta_ended`) and each beta issue is told once (`told`), and `written_back_at` closes the row.
 */
export const betaPortReleases = pgTable(
  'beta_port_releases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The beta release's run id on forge-beta: another instance's, so never a foreign key here. */
    betaRunId: text('beta_run_id').notNull(),
    betaProjectId: text('beta_project_id').notNull(),
    betaProjectSlug: text('beta_project_slug').notNull(),
    /** The version beta cut for it; null where beta's release names none. */
    betaVersion: text('beta_version'),
    betaStartedAt: timestamp('beta_started_at', { withTimezone: true }).notNull(),
    betaIssues: jsonb('beta_issues').$type<BetaReleaseIssue[]>().notNull(),
    devProjectId: uuid('dev_project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The dev issues the beta issues map to: their twins, or the issues their Feedback routed to. */
    devIssueIds: jsonb('dev_issue_ids').$type<string[]>().notNull().default([]),
    /** Each beta issue with no dev twin, named with why. */
    noTwin: jsonb('no_twin').$type<string[]>().notNull().default([]),
    state: text('state', { enum: BETA_PORT_RELEASE_STATES }).notNull(),
    /** What the latest fire said of it: the dev issues not ready, or the refusal a cut met. */
    said: text('said'),
    /** The dev release cut for it, and the version it wears. */
    devRunId: uuid('dev_run_id'),
    devVersion: text('dev_version'),
    /** How the beta release was ended on beta once the dev release settled; null while owed. */
    betaEnded: text('beta_ended'),
    /** The beta issues already told the dev release's outcome, so each is told once. */
    told: jsonb('told').$type<string[]>().notNull().default([]),
    writtenBackAt: timestamp('written_back_at', { withTimezone: true }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    betaRunUq: uniqueIndex('beta_port_releases_beta_run_uq').on(t.betaRunId),
    markIdx: index('beta_port_releases_mark_idx').on(t.betaProjectSlug, t.betaStartedAt),
    stateChk: check(
      'beta_port_releases_state_chk',
      sql`${t.state} IN (${sql.raw(BETA_PORT_RELEASE_STATES.map((s) => `'${s}'`).join(', '))})`,
    ),
  }),
);
