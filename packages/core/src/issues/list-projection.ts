import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type MergeMarkColumns, type MergeMarkKind, mergeMarkKindOf } from './merge-record.js';
import type { IssueSearchField } from './search-predicate.js';

/**
 * The columns both REST issue lists select. Heavy TOAST columns
 * (`description`, `plan`, `acceptanceCriteria`, `sessionContext`,
 * `releaseNotes`) and the `ident_search` tsvector are never read from disk:
 * on the beta database those carry 93 MB of TOAST against an 8.9 MB heap, and
 * a page of 200 rows pulled all of it through the process to serialize it.
 */
export const REST_ISSUE_LIST_COLUMNS = {
  id: issues.id,
  projectId: issues.projectId,
  issSeq: issues.issSeq,
  title: issues.title,
  status: issues.status,
  waitingKind: issues.waitingKind,
  priority: issues.priority,
  category: issues.category,
  complexity: issues.complexity,
  assigneeId: issues.assigneeId,
  createdById: issues.createdById,
  createdByDeviceId: issues.createdByDeviceId,
  createdVia: issues.createdVia,
  reportedBy: issues.reportedBy,
  detectorKey: issues.detectorKey,
  source: issues.source,
  externalId: issues.externalId,
  reopenCount: issues.reopenCount,
  mergedAt: issues.mergedAt,
  mergedCommitSha: issues.mergedCommitSha,
  mergedLanding: issues.mergedLanding,
  releaseBatchRunId: issues.releaseBatchRunId,
  metadata: issues.metadata,
  archivedAt: issues.archivedAt,
  createdAt: issues.createdAt,
  updatedAt: issues.updatedAt,
  /** ISS-1257 — since when a person has owed this issue an answer: its oldest open `human` question. */
  waitingOnPersonSince: sql<Date | null>`(
    select min(q.created_at) from agent_questions q
     where q.issue_id = issues.id and q.status = 'open' and q.blocker_kind = 'human'
  )`
    .mapWith(issues.createdAt)
    .as('waiting_on_person_since'),
} as const;

/** The names this projection deliberately does not select, so a test asserts on the set. */
export const REST_ISSUE_LIST_OMITTED = [
  'description',
  'descriptionFormat',
  'plan',
  'acceptanceCriteria',
  'sessionContext',
  'releaseNotes',
  'identSearch',
] as const;

/**
 * ISS-1126 — the sha has been in this projection since ISS-959; `mergeMark` is what makes it
 * legible. The reading is `merge-record.ts`'s, so a list row and the issue detail cannot disagree
 * about which kind of mark the same issue carries.
 */
export function serializeRestListRow<T extends { issSeq: number } & MergeMarkColumns>(
  row: T,
  prefix: string | null,
): T & { displayId: string; mergeMark: MergeMarkKind } {
  return {
    ...row,
    displayId: formatIssueRef(prefix, row.issSeq),
    mergeMark: mergeMarkKindOf(row),
  };
}

/** One page of either REST issue list, ordered and limited. */
export function issueListPageQuery(opts: {
  where: SQL | undefined;
  orderBy: SQL;
  limit: number;
  offset: number;
  matchedFields?: SQL<IssueSearchField[]> | null;
}) {
  const columns = opts.matchedFields
    ? { ...REST_ISSUE_LIST_COLUMNS, matchedFields: opts.matchedFields }
    : REST_ISSUE_LIST_COLUMNS;
  return db
    .select(columns)
    .from(issues)
    .where(opts.where)
    .orderBy(opts.orderBy)
    .limit(opts.limit)
    .offset(opts.offset);
}
