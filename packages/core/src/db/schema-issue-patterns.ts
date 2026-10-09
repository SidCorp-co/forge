import { ISSUE_PATTERN_KINDS, PATTERN_DECISIONS, PATTERN_LIMITS } from '@forge/contracts/patterns';
import { type SQL, sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { issues, projects, users } from './schema.js';

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

// The patterns an issue names (REQ-36 BC-2, BC-3; Issue lifecycle r14 `design-check`), written by the
// issue kernel (`issues/patterns.ts`). A `reuse` is catalogued and nobody decides it; a `new` one waits
// on one reviewer, and its decision is taken once. A returned row stays as history; naming the slug
// again opens a new review. `issue_pattern_guard()` (0474) refuses a write that re-aims a row,
// changes a decision or unretracts one.
export const issuePatterns = pgTable(
  'issue_patterns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    pattern: text('pattern').notNull(),
    kind: text('kind', { enum: ISSUE_PATTERN_KINDS }).notNull(),
    summary: text('summary'),
    namedBy: uuid('named_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    namedAgency: text('named_agency', { enum: ['human', 'agent'] }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decision: text('decision', { enum: PATTERN_DECISIONS }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
    decidedAgency: text('decided_agency', { enum: ['human', 'agent'] }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
    retractedBy: uuid('retracted_by').references(() => users.id, { onDelete: 'restrict' }),
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
    retractReason: text('retract_reason'),
  },
  (t) => ({
    liveUq: uniqueIndex('issue_patterns_live_uq')
      .on(t.issueId, t.pattern)
      .where(sql`retracted_at IS NULL AND decision IS DISTINCT FROM 'returned'`),
    issueIdx: index('issue_patterns_issue_idx').on(t.issueId),
    pendingIdx: index('issue_patterns_pending_idx')
      .on(t.projectId, t.issueId)
      .where(sql`kind = 'new' AND decision IS NULL AND retracted_at IS NULL`),
    patternChk: check(
      'issue_patterns_pattern_chk',
      sql`${t.pattern} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`,
    ),
    kindChk: check('issue_patterns_kind_chk', sql`${t.kind} IN (${quoted(ISSUE_PATTERN_KINDS)})`),
    summaryChk: check(
      'issue_patterns_summary_chk',
      sql`${t.summary} IS NULL OR length(${t.summary}) BETWEEN 1 AND ${sql.raw(String(PATTERN_LIMITS.summary))}`,
    ),
    newSummaryChk: check(
      'issue_patterns_new_summary_chk',
      sql`${t.kind} <> 'new' OR ${t.summary} IS NOT NULL`,
    ),
    decisionChk: check(
      'issue_patterns_decision_chk',
      sql`${t.decision} IS NULL OR (${t.kind} = 'new' AND ${t.decision} IN (${quoted(PATTERN_DECISIONS)}))`,
    ),
    decidedChk: check(
      'issue_patterns_decided_chk',
      sql`(${t.decision} IS NULL) = (${t.decidedBy} IS NULL) AND (${t.decision} IS NULL) = (${t.decidedAt} IS NULL) AND (${t.decision} IS NULL) = (${t.decisionReason} IS NULL)`,
    ),
    reasonChk: check(
      'issue_patterns_reason_chk',
      sql`${t.decisionReason} IS NULL OR length(${t.decisionReason}) BETWEEN 1 AND ${sql.raw(String(PATTERN_LIMITS.reason))}`,
    ),
    agencyChk: check(
      'issue_patterns_agency_chk',
      sql`(${t.namedAgency} IS NULL OR ${t.namedAgency} IN ('human', 'agent')) AND (${t.decidedAgency} IS NULL OR ${t.decidedAgency} IN ('human', 'agent'))`,
    ),
    retractedChk: check(
      'issue_patterns_retracted_chk',
      sql`(${t.retractedAt} IS NULL) = (${t.retractedBy} IS NULL) AND (${t.retractedAt} IS NULL) = (${t.retractReason} IS NULL)`,
    ),
    retractReasonChk: check(
      'issue_patterns_retract_reason_chk',
      sql`${t.retractReason} IS NULL OR length(${t.retractReason}) BETWEEN 1 AND ${sql.raw(String(PATTERN_LIMITS.reason))}`,
    ),
  }),
);

/** A new pattern no reviewer has decided holds its issue out of dispatch: the one predicate every door reads. */
export function patternReviewPendingSql(issueId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM issue_patterns ip
    WHERE ip.issue_id = ${issueId}
      AND ip.kind = 'new'
      AND ip.decision IS NULL
      AND ip.retracted_at IS NULL
  )`;
}
