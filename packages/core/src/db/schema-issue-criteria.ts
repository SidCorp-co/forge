// ISS-55 — an issue's acceptance criteria and the verdicts on them are rows, not comment prose.
// `issue_criteria` holds one row per criterion (its number is what a verdict names); a reworded or
// removed criterion is retired, never deleted, so the verdicts on it stay readable.
// `criterion_verdicts` is insert-only: the latest row per criterion is what the
// `awaiting_release` gate reads (`issues/criteria/store.ts:latestVerdictsByNumber`).

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { comments, issues, users } from './schema.js';
import { projectWorkflows } from './schema-workflows.js';

export const issueCriteria = pgTable(
  'issue_criteria',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    /** The number a verdict names (`criterion: 3`), stable for the life of the row. */
    n: integer('n').notNull(),
    statement: text('statement').notNull(),
    position: integer('position').notNull(),
    // cm:seam ISS-57 — the requirement criterion (BC-n) this issue criterion proves. The FK to
    // `requirement_criteria` lands with ISS-57's table; until then it is a bare nullable uuid.
    requirementCriterionId: uuid('requirement_criterion_id'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nChk: check('issue_criteria_n_chk', sql`${t.n} >= 1`),
    statementChk: check('issue_criteria_statement_chk', sql`${t.statement} ~ '[^[:space:]]'`),
    liveNUq: uniqueIndex('issue_criteria_live_n_uq')
      .on(t.issueId, t.n)
      .where(sql`retired_at IS NULL`),
    issueIdx: index('issue_criteria_issue_idx').on(t.issueId, t.position),
  }),
);

/** pass/fail/skipped, plus `short`: forge-plugin's "met short of its wording, judged not to block". */
export const verdictValues = ['pass', 'short', 'fail', 'skipped'] as const;
export type VerdictValue = (typeof verdictValues)[number];

/** `commit_unresolved` exists only on backfilled rows (`backfilled = true`), never on a new one. */
export const verdictIdentityKinds = [
  'commit',
  'runtime',
  'design',
  'contract',
  'commit_unresolved',
] as const;
export type VerdictIdentityKind = (typeof verdictIdentityKinds)[number];

export const criterionVerdicts = pgTable(
  'criterion_verdicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    criterionId: uuid('criterion_id')
      .notNull()
      .references(() => issueCriteria.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    verdict: text('verdict', { enum: verdictValues }).notNull(),
    reason: text('reason'),
    identityKind: text('identity_kind', { enum: verdictIdentityKinds }),
    commitSha: text('commit_sha'),
    runtimeRef: text('runtime_ref'),
    designWorkflowId: uuid('design_workflow_id').references(() => projectWorkflows.id, {
      onDelete: 'restrict',
    }),
    designRevision: integer('design_revision'),
    contractRef: text('contract_ref'),
    contractVersion: text('contract_version'),
    evidence: text('evidence').array().notNull().default(sql`'{}'::text[]`),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorDeviceId: uuid('author_device_id'),
    authorAgency: text('author_agency', { enum: ['human', 'agent'] }).notNull(),
    /** The comment whose `forge-record: verdict` fence this row was read from (dual path). */
    commentId: uuid('comment_id').references(() => comments.id, { onDelete: 'set null' }),
    backfilled: boolean('backfilled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    verdictChk: check(
      'criterion_verdicts_verdict_chk',
      sql`${t.verdict} IN ('pass', 'short', 'fail', 'skipped')`,
    ),
    skippedReasonChk: check(
      'criterion_verdicts_skipped_reason_chk',
      sql`${t.verdict} <> 'skipped' OR coalesce(${t.reason}, '') ~ '[^[:space:]]'`,
    ),
    earnedIdentityChk: check(
      'criterion_verdicts_earned_identity_chk',
      sql`${t.verdict} NOT IN ('pass', 'short') OR ${t.identityKind} IS NOT NULL`,
    ),
    identityChk: check(
      'criterion_verdicts_identity_chk',
      sql`(${t.identityKind} IS NULL AND ${t.commitSha} IS NULL AND ${t.runtimeRef} IS NULL AND ${t.designWorkflowId} IS NULL AND ${t.designRevision} IS NULL AND ${t.contractRef} IS NULL AND ${t.contractVersion} IS NULL)
        OR (${t.identityKind} = 'commit' AND ${t.commitSha} ~ '^[0-9a-f]{40}$' AND ${t.runtimeRef} IS NULL AND ${t.designWorkflowId} IS NULL AND ${t.designRevision} IS NULL AND ${t.contractRef} IS NULL AND ${t.contractVersion} IS NULL)
        OR (${t.identityKind} = 'commit_unresolved' AND ${t.backfilled} AND ${t.commitSha} ~ '^[0-9a-f]{7,39}$' AND ${t.runtimeRef} IS NULL AND ${t.designWorkflowId} IS NULL AND ${t.designRevision} IS NULL AND ${t.contractRef} IS NULL AND ${t.contractVersion} IS NULL)
        OR (${t.identityKind} = 'runtime' AND ${t.runtimeRef} ~ '^[0-9a-f]{40,64}$' AND ${t.commitSha} IS NULL AND ${t.designWorkflowId} IS NULL AND ${t.designRevision} IS NULL AND ${t.contractRef} IS NULL AND ${t.contractVersion} IS NULL)
        OR (${t.identityKind} = 'design' AND ${t.designWorkflowId} IS NOT NULL AND ${t.designRevision} >= 1 AND ${t.commitSha} IS NULL AND ${t.runtimeRef} IS NULL AND ${t.contractRef} IS NULL AND ${t.contractVersion} IS NULL)
        OR (${t.identityKind} = 'contract' AND ${t.contractRef} ~ '[^[:space:]]' AND ${t.contractVersion} ~ '[^[:space:]]' AND ${t.commitSha} IS NULL AND ${t.runtimeRef} IS NULL AND ${t.designWorkflowId} IS NULL AND ${t.designRevision} IS NULL)`,
    ),
    latestIdx: index('criterion_verdicts_latest_idx').on(t.criterionId, t.createdAt),
    issueIdx: index('criterion_verdicts_issue_idx').on(t.issueId),
  }),
);

export type IssueCriterionRow = typeof issueCriteria.$inferSelect;
export type CriterionVerdictRow = typeof criterionVerdicts.$inferSelect;
