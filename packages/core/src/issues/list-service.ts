import {
  and,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  lt,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type IssueComplexity,
  type IssueStatus,
  issueLabels,
  issues,
  jobs,
  usageRecords,
} from '../db/schema.js';
import { issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { holdsOpenHumanQuestion } from '../questions/issue-coupling.js';
import { usageSessionMatch } from '../usage-records/rollup.js';
import { issueArchiveSide } from './archive.js';
import { buildCreatedByCondition, buildOriginCondition } from './creator.js';
import { heldIssuePrefixes } from './issue-prefix-read.js';
import { resolveLabelIdsTolerant, resolveModuleIdsTolerant } from './label-service.js';
import { REST_ISSUE_LIST_COLUMNS } from './list-projection.js';
import { buildIssueSearchCondition, matchedSearchFieldsSql } from './search-predicate.js';
import { buildIssueOrderBy, type IssueSort } from './sort.js';

/** Every filter the issue list takes; both REST list routes read the same set. */
export type IssueListFilters = {
  status?: readonly IssueStatus[] | undefined;
  statusNot?: readonly IssueStatus[] | undefined;
  /** Widens `status` to also match an issue a person owes an answer. */
  orWaitingOnPerson?: boolean | undefined;
  priority?: readonly (typeof issues.$inferSelect)['priority'][] | undefined;
  assigneeId?: string | undefined;
  createdBy?: string | undefined;
  origin?: 'detector' | 'human' | undefined;
  category?: string | undefined;
  complexity?: IssueComplexity | undefined;
  /** A display id or bare sequence number; a key is retrieval, so it reaches archived issues. */
  key?: string | undefined;
  createdAfter?: Date | undefined;
  createdBefore?: Date | undefined;
  updatedAfter?: Date | undefined;
  search?: string | undefined;
  /** Label names or ids; an unknown name is dropped, and none resolving matches nothing. */
  label?: readonly string[] | undefined;
  module?: readonly string[] | undefined;
  includeArchived?: boolean | undefined;
};

export type IssueListPage = {
  sort: IssueSort;
  limit: number;
  offset: number;
  withBuckets?: boolean | undefined;
};

export interface IssueBuckets {
  /** How many issues sit at each kernel status, under every filter except status and origin. */
  readonly byStatus: Record<string, number>;
  /** Machine-filed issues (a detectorKey), at any status. */
  readonly detector: number;
  /** Drafts a person filed, which is what the Draft tab means. */
  readonly humanDraft: number;
  /** Issues a person owes an answer (an open `human` question), by status, once each. */
  readonly waitingOnPersonByStatus: Record<string, number>;
}

function pageQuery(where: SQL | undefined, page: IssueListPage, search: string | undefined) {
  const columns = search
    ? { ...REST_ISSUE_LIST_COLUMNS, matchedFields: matchedSearchFieldsSql(search) }
    : REST_ISSUE_LIST_COLUMNS;
  return db
    .select(columns)
    .from(issues)
    .where(where)
    .orderBy(buildIssueOrderBy(page.sort))
    .limit(page.limit)
    .offset(page.offset);
}

export type IssueListRow = Awaited<ReturnType<typeof pageQuery>>[number];

export type IssueListAnswer =
  | { ok: true; rows: IssueListRow[]; total: number; buckets: IssueBuckets | null }
  | { ok: false; field: 'key' | 'orWaitingOnPerson'; message: string };

const labelledWith = (labelIds: string[]) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(issueLabels)
      .where(and(eq(issueLabels.issueId, issues.id), inArray(issueLabels.labelId, labelIds))),
  );

async function countBuckets(axisFree: SQL[]): Promise<IssueBuckets> {
  const base = and(...axisFree);
  const byStatusOf = (where: SQL | undefined) =>
    db
      .select({ status: issues.status, n: count() })
      .from(issues)
      .where(where)
      .groupBy(issues.status);
  const [rows, marked, [detector] = [{ n: 0 }], [humanDraft] = [{ n: 0 }]] = await Promise.all([
    byStatusOf(base),
    byStatusOf(and(base, holdsOpenHumanQuestion(issues.id))),
    db
      .select({ n: count() })
      .from(issues)
      .where(and(base, buildOriginCondition('detector'))),
    db
      .select({ n: count() })
      .from(issues)
      .where(and(base, eq(issues.status, 'draft'), buildOriginCondition('human'))),
  ]);
  const tally = (rs: Array<{ status: string; n: number }>) =>
    Object.fromEntries(rs.map((r) => [r.status, Number(r.n)]));
  return {
    byStatus: tally(rows),
    detector: Number(detector?.n ?? 0),
    humanDraft: Number(humanDraft?.n ?? 0),
    waitingOnPersonByStatus: tally(marked),
  };
}

/** One page of a project's issues under `filters`, its total, and the status buckets when asked. */
export async function listIssues(
  projectId: string,
  filters: IssueListFilters,
  page: IssueListPage,
): Promise<IssueListAnswer> {
  const conditions: SQL[] = [eq(issues.projectId, projectId)];
  const axisFree: SQL[] = [eq(issues.projectId, projectId)];
  const both = (cond: SQL) => {
    conditions.push(cond);
    axisFree.push(cond);
  };
  const empty: IssueListAnswer = { ok: true, rows: [], total: 0, buckets: null };
  if (filters.orWaitingOnPerson && !filters.status?.length) {
    return {
      ok: false,
      field: 'orWaitingOnPerson',
      message:
        'widens a `status` filter to also match an issue a person owes an answer, and this request names no `status`. Send it with `status`, or send neither',
    };
  }

  for (const side of issueArchiveSide(
    filters.includeArchived === true || filters.key !== undefined,
  ))
    both(side);
  if (filters.key !== undefined) {
    const parsed = parseIssueRef(
      filters.key,
      issueRefNeedsHeldPrefixes(filters.key) ? await heldIssuePrefixes(projectId) : [],
    );
    if (!parsed.ok) return { ok: false, field: 'key', message: parsed.message };
    both(eq(issues.issSeq, parsed.issSeq));
  }
  if (filters.search) both(buildIssueSearchCondition(filters.search));
  if (filters.status?.length) {
    const atStatus = inArray(issues.status, [...filters.status]);
    conditions.push(
      filters.orWaitingOnPerson
        ? (or(atStatus, holdsOpenHumanQuestion(issues.id)) as SQL)
        : atStatus,
    );
  }
  if (filters.statusNot?.length) conditions.push(notInArray(issues.status, [...filters.statusNot]));
  if (filters.priority?.length) both(inArray(issues.priority, [...filters.priority]));
  if (filters.assigneeId) both(eq(issues.assigneeId, filters.assigneeId));
  if (filters.createdBy) both(buildCreatedByCondition(filters.createdBy));
  if (filters.origin) conditions.push(buildOriginCondition(filters.origin));
  if (filters.category) both(eq(issues.category, filters.category));
  if (filters.complexity) both(eq(issues.complexity, filters.complexity));
  if (filters.createdAfter) both(gte(issues.createdAt, filters.createdAfter));
  if (filters.createdBefore) both(lt(issues.createdAt, filters.createdBefore));
  if (filters.updatedAfter) both(gte(issues.updatedAt, filters.updatedAfter));
  for (const [values, resolve] of [
    [filters.label, resolveLabelIdsTolerant],
    [filters.module, resolveModuleIdsTolerant],
  ] as const) {
    if (!values?.length) continue;
    const ids = await resolve(projectId, values);
    if (ids.length === 0) return empty;
    both(labelledWith(ids));
  }

  const where = and(...conditions);
  const [[{ n } = { n: 0 }], rows, buckets] = await Promise.all([
    db.select({ n: count() }).from(issues).where(where),
    pageQuery(where, page, filters.search),
    page.withBuckets ? countBuckets(axisFree) : Promise.resolve(null),
  ]);
  return { ok: true, rows, total: Number(n), buckets };
}

/** Each issue's estimated cost: the usage of every session its jobs ran in. */
export async function sumCostByIssue(issueIds: string[]): Promise<Map<string, number>> {
  if (issueIds.length === 0) return new Map();
  const pairs = db
    .selectDistinct({ issueId: jobs.issueId, sessionId: jobs.agentSessionId })
    .from(jobs)
    .where(and(inArray(jobs.issueId, issueIds), isNotNull(jobs.agentSessionId)))
    .as('issue_sessions');
  const rows = await db
    .select({
      issueId: pairs.issueId,
      estimatedCost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
    })
    .from(pairs)
    .innerJoin(usageRecords, usageSessionMatch(sql`= ${pairs.sessionId}::text`))
    .groupBy(pairs.issueId);
  return new Map(rows.map((r) => [r.issueId as string, r.estimatedCost]));
}

export type IssueFailureInfo = {
  failedStep: string;
  failureReason: string | null;
  failureKind: string | null;
  failedAt: string;
};

/** The most recent failed job per issue, in one grouped query. */
export async function latestFailedJobByIssue(
  issueIds: string[],
): Promise<Map<string, IssueFailureInfo>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([jobs.issueId], {
      issueId: jobs.issueId,
      failedStep: jobs.type,
      failureReason: jobs.failureReason,
      failureKind: jobs.failureKind,
      finishedAt: jobs.finishedAt,
    })
    .from(jobs)
    .where(and(inArray(jobs.issueId, issueIds), eq(jobs.status, 'failed'), isNotNull(jobs.issueId)))
    .orderBy(jobs.issueId, desc(jobs.finishedAt));
  return new Map(
    rows
      .filter((r): r is typeof r & { issueId: string } => r.issueId !== null)
      .map((r) => [
        r.issueId,
        {
          failedStep: r.failedStep,
          failureReason: r.failureReason,
          failureKind: r.failureKind,
          failedAt: r.finishedAt?.toISOString() ?? new Date(0).toISOString(),
        },
      ]),
  );
}
