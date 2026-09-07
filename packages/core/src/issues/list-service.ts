import { and, desc, eq, exists, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issueLabels, issues } from '../db/schema.js';
import { resolveLabelIdsTolerant, resolveModuleIdsTolerant } from './label-service.js';
import {
  buildIssueSearchCondition,
  type IssueSearchField,
  matchedSearchFieldsSql,
} from './search-predicate.js';

export type IssueListFilters = {
  status?: IssueStatus | undefined;
  statusNot?: IssueStatus | undefined;
  priority?: (typeof issues.$inferSelect)['priority'] | undefined;
  category?: string | undefined;
  complexity?: (typeof issues.$inferSelect)['complexity'] | undefined;
  createdAfter?: Date | undefined;
  createdBefore?: Date | undefined;
  updatedAfter?: Date | undefined;
  search?: string | undefined;
  label?: readonly string[] | undefined;
  module?: readonly string[] | undefined;
};

/**
 * ISS-562 — the light-column projection. Heavy TOAST columns (description,
 * plan, acceptanceCriteria, sessionContext, releaseNotes) are never read from
 * disk, so a browse over many populated issues costs a fraction of a full row.
 */
export type IssueListRow = {
  id: string;
  issSeq: number;
  title: string;
  status: IssueStatus;
  priority: string;
  category: string | null;
  complexity: string | null;
  assigneeId: string | null;
  reopenCount: number;
  mergedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** ISS-960 — present only when the query carried `search`. */
  matchedFields?: IssueSearchField[];
};

/** The agent-facing browse query. */
export async function listIssueRows(
  projectId: string,
  filters: IssueListFilters | undefined,
  limit: number,
): Promise<IssueListRow[]> {
  const conds = [eq(issues.projectId, projectId)];
  if (filters?.status) conds.push(eq(issues.status, filters.status));
  if (filters?.statusNot) conds.push(ne(issues.status, filters.statusNot));
  if (filters?.priority) conds.push(eq(issues.priority, filters.priority));
  if (filters?.category) conds.push(eq(issues.category, filters.category));
  if (filters?.complexity) conds.push(eq(issues.complexity, filters.complexity));
  if (filters?.createdAfter) conds.push(gte(issues.createdAt, filters.createdAfter));
  if (filters?.createdBefore) conds.push(lt(issues.createdAt, filters.createdBefore));
  if (filters?.updatedAfter) conds.push(gte(issues.updatedAt, filters.updatedAfter));
  if (filters?.search) conds.push(buildIssueSearchCondition(filters.search));

  for (const [values, resolve] of [
    [filters?.label, resolveLabelIdsTolerant],
    [filters?.module, resolveModuleIdsTolerant],
  ] as const) {
    if (values === undefined) continue;
    const resolvedIds = await resolve(projectId, values);
    // cm:guard an empty resolution means NO issues, never "skip this filter" — dropping it returns every row in the project and the caller reads that as "nothing matched"
    if (resolvedIds.length === 0) return [];
    conds.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(issueLabels)
          .where(
            and(eq(issueLabels.issueId, issues.id), inArray(issueLabels.labelId, resolvedIds)),
          ),
      ),
    );
  }

  const projection = {
    id: issues.id,
    issSeq: issues.issSeq,
    title: issues.title,
    status: issues.status,
    priority: issues.priority,
    category: issues.category,
    complexity: issues.complexity,
    assigneeId: issues.assigneeId,
    reopenCount: issues.reopenCount,
    mergedAt: issues.mergedAt,
    createdAt: issues.createdAt,
    updatedAt: issues.updatedAt,
  };

  // cm:why ISS-960 — `matchedFields` is computed by Postgres and only when a search was asked for: the projection above exists so `plan` and `acceptanceCriteria` are never detoasted into the app (ISS-562), and reading them back to name the match would undo exactly that
  const selected = filters?.search
    ? db.select({ ...projection, matchedFields: matchedSearchFieldsSql(filters.search) })
    : db.select(projection);

  return selected
    .from(issues)
    .where(and(...conds))
    .orderBy(desc(issues.updatedAt))
    .limit(limit);
}
