import {
  RELEASE_ATTEMPT_STAGES,
  RELEASE_HOLD_OWERS,
  type ReleaseAttemptStage,
} from '@forge/contracts/releases';
import { type InferSelectModel, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { issues, pipelineRuns, projects, users } from './schema.js';

export { RELEASE_ATTEMPT_STAGES, type ReleaseAttemptStage };

export const releaseAttempts = pgTable(
  'release_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    stage: text('stage').$type<ReleaseAttemptStage>().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    commit: text('commit'),
    providerRef: text('provider_ref'),
    health: text('health').$type<'up' | 'down'>(),
    identity: text('identity'),
    /** Core's verdict. NULL until the act reports back; `unverified` where no probe was declared
     *  to read, which is neither a pass nor a red (ISS-1321). A text column, so no migration. */
    verdict: text('verdict').$type<'ok' | 'failed' | 'unverified'>(),
    /** Why the verdict, in core's words. */
    verdictReason: text('verdict_reason'),
    /** One line per probe, in declaration order, whatever the outcome. */
    readings: jsonb('readings').$type<string[]>(),
    /** The agent's own account of this act, stored beside the verdict. */
    account: text('account'),
    /** The tail of whatever the act printed. */
    logTail: text('log_tail'),
    logTailTruncated: boolean('log_tail_truncated').notNull().default(false),
    /** NULL means nobody has read past the cut. */
    logTailReadAt: timestamp('log_tail_read_at', { withTimezone: true }),
    logTailReadBy: uuid('log_tail_read_by'),
    /** When the intent was recorded — BEFORE the act it describes. */
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the act reported back. NULL means it never did. */
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => ({
    runKeyUq: unique('release_attempts_run_key_uq').on(t.runId, t.idempotencyKey),
    runIdx: index('release_attempts_run_idx').on(t.runId, t.startedAt),
  }),
);

export type ReleaseAttemptRow = InferSelectModel<typeof releaseAttempts>;

export const RELEASE_APPROVAL_DECISIONS = ['approved', 'returned'] as const;
export type ReleaseApprovalDecision = (typeof RELEASE_APPROVAL_DECISIONS)[number];

export const releaseApprovals = pgTable(
  'release_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: 'cascade' }),
    requestedByUser: uuid('requested_by_user')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    evidenceEnvironment: text('evidence_environment').notNull(),
    evidenceCommit: text('evidence_commit').notNull(),
    evidenceReading: text('evidence_reading').notNull(),
    note: text('note'),
    decision: text('decision').$type<ReleaseApprovalDecision>(),
    decidedByUser: uuid('decided_by_user').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    reason: text('reason'),
  },
  (t) => ({
    onePendingUq: uniqueIndex('release_approvals_one_pending_uq')
      .on(t.runId)
      .where(sql`${t.decision} IS NULL`),
    runIdx: index('release_approvals_run_idx').on(t.runId, t.requestedAt),
    projectIdx: index('release_approvals_project_idx').on(t.projectId, t.requestedAt),
    decisionChk: check(
      'release_approvals_decision_chk',
      sql`${t.decision} IS NULL OR ${t.decision} IN ('approved', 'returned')`,
    ),
    decidedChk: check(
      'release_approvals_decided_chk',
      sql`(${t.decision} IS NULL) = (${t.decidedByUser} IS NULL) AND (${t.decision} IS NULL) = (${t.decidedAt} IS NULL)`,
    ),
    reasonChk: check(
      'release_approvals_reason_chk',
      sql`(${t.decision} = 'returned') = (${t.reason} IS NOT NULL)`,
    ),
    commitChk: check('release_approvals_commit_chk', sql`${t.evidenceCommit} ~ '^[0-9a-f]{40}$'`),
  }),
);

export type ReleaseApprovalRow = InferSelectModel<typeof releaseApprovals>;

/**
 * Why the automatic release is not taking an issue waiting at its gate. One standing row per
 * issue (`cleared_at IS NULL`); a changed reason clears the standing row and adds its successor,
 * so the rows are the history of what held it.
 */
export const releaseHolds = pgTable(
  'release_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    reason: text('reason').notNull(),
    owes: text('owes', { enum: RELEASE_HOLD_OWERS }).notNull(),
    waitingFor: text('waiting_for').notNull(),
    heldAt: timestamp('held_at', { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
  },
  (t) => ({
    owesChk: check(
      'release_holds_owes_chk',
      sql`${t.owes} IN (${sql.raw(RELEASE_HOLD_OWERS.map((o) => `'${o}'`).join(', '))})`,
    ),
    standingUq: uniqueIndex('release_holds_standing_uq')
      .on(t.issueId)
      .where(sql`cleared_at IS NULL`),
    projectIdx: index('release_holds_project_idx')
      .on(t.projectId, t.heldAt)
      .where(sql`cleared_at IS NULL`),
  }),
);

export type ReleaseHoldRow = InferSelectModel<typeof releaseHolds>;
