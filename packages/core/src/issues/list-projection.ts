import type { SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues, type WaitingKind } from '../db/schema.js';
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
  createdVia: issues.createdVia,
  reportedBy: issues.reportedBy,
  detectorKey: issues.detectorKey,
  source: issues.source,
  externalId: issues.externalId,
  reopenCount: issues.reopenCount,
  mergedAt: issues.mergedAt,
  mergedCommitSha: issues.mergedCommitSha,
  releaseBatchRunId: issues.releaseBatchRunId,
  metadata: issues.metadata,
  archivedAt: issues.archivedAt,
  createdAt: issues.createdAt,
  updatedAt: issues.updatedAt,
} as const;

/** One row as the two REST list endpoints select it. */
export type RestIssueListRow = {
  id: string;
  projectId: string;
  issSeq: number;
  title: string;
  status: IssueStatus;
  waitingKind: WaitingKind | null;
  priority: (typeof issues.$inferSelect)['priority'];
  category: string | null;
  complexity: (typeof issues.$inferSelect)['complexity'];
  assigneeId: string | null;
  createdById: string;
  createdVia: (typeof issues.$inferSelect)['createdVia'];
  reportedBy: string | null;
  detectorKey: string | null;
  source: (typeof issues.$inferSelect)['source'];
  externalId: string | null;
  reopenCount: number;
  mergedAt: Date | null;
  mergedCommitSha: string | null;
  releaseBatchRunId: string | null;
  metadata: (typeof issues.$inferSelect)['metadata'];
  /** ISS-1237 — set only on a row a caller asked for with `includeArchived` or by key. */
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** ISS-960 — present only when the query carried a search term. */
  matchedFields?: IssueSearchField[];
};

/**
 * The names this projection deliberately does not select, so a test can assert
 * on the set rather than on a hand-copied list that drifts from it.
 */
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
