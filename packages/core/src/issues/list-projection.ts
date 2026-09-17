// cm:guard ISS-1016 — the ONE place the REST issue-list row is named, for `GET /api/projects/:id/issues` (routes.ts) and `GET /api/projects/:id/issues/search` (search.ts). It is deliberately NOT `list-service.ts`'s `IssueListRow`: that one is the MCP browse row and omits `createdById` and `createdVia`, which creator hydration on both REST routes reads off the row it selected. Copying it here would make both endpoints answer with a null creator.
// cm:guard what this drops is what the row costs to read, never what a caller might want: the six TOAST-eligible body columns and the `ident_search` tsvector, which is a generated search index no client can use. Every scalar stays — `metadata` because web-v2's run drawer reads `metadata.branchConfig.branch` off a search row, `createdById` because its issues list groups on it. Adding a column back is one line here; dropping one is a contract change and needs the consumer sweep the filing asked for.

import type { SQL } from 'drizzle-orm';
import { type IssueStatus, issues, type WaitingKind } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
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

// cm:guard a list row gets `displayId` and NOTHING else derived. `serializeIssue` in routes.ts also grafts `descriptionNodes`, which is parsed from a column this projection does not read — and because its own signature takes the body columns as OPTIONAL, handing it a row from here type-checks and answers `descriptionNodes: null` on every row. That is the silent substitution this function exists to refuse: the list says nothing about a body rather than saying the body is empty.
export function serializeRestListRow<T extends { issSeq: number }>(
  row: T,
  prefix: string | null,
): T & { displayId: string } {
  return { ...row, displayId: formatIssueRef(prefix, row.issSeq) };
}

// cm:guard ISS-1016 — both REST list handlers get their page from HERE and build no `db.select()` of their own, because the index assertions in `issue-list-index-plan-e2e.test.ts` EXPLAIN what this returns. A handler with a query of its own is a query no plan test covers, and an EXPLAIN over a hand-built copy of it proves nothing about what production runs — which is the mistake ISS-1015 shipped and caught in review.
/** One page of either REST issue list, ordered and limited. */
export function issueListPageQuery(opts: {
  where: SQL;
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
