import { zValidator } from '@hono/zod-validator';
import {
  and,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  notInArray,
  type SQL,
  sql,
} from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  issueLabels,
  issuePriorities,
  issueStatuses,
  issues,
  type JobType,
  jobs,
  usageRecords,
} from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { listResponse } from '../lib/pagination.js';
import { queryBadRequest } from '../lib/query-strict.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { usageSessionMatch } from '../usage-records/rollup.js';
import { hydrateAgentSessionsForIssues } from './agent-sessions-hydrator.js';
import { issueArchiveSide } from './archive.js';
import {
  buildCreatedByCondition,
  buildOriginCondition,
  hydrateCreatorsForIssues,
} from './creator.js';
import { loadIssueDependencyEdgesForIssues } from './dependency-read.js';
import { hydrateHeldForIssues } from './held-hydrator.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import { listModulesForIssues, resolveModuleIdsTolerant } from './label-service.js';
import { issueListPageQuery, serializeRestListRow } from './list-projection.js';
import { safeHydratePipelineHealthForIssues } from './pipeline-health.js';
import { buildIssueSearchCondition, matchedSearchFieldsSql } from './search-predicate.js';
import { buildIssueOrderBy, issueSortValues } from './sort.js';

export interface IssueBuckets {
  /** How many issues sit at each kernel status, under every filter except status and origin. */
  readonly byStatus: Record<string, number>;
  /** Machine-filed issues (a detectorKey), at any status. */
  readonly detector: number;
  /** Drafts a person filed, which is what the Draft tab means. */
  readonly humanDraft: number;
}

async function countBuckets(axisFree: SQL[]): Promise<IssueBuckets> {
  const base = axisFree.length === 1 ? axisFree[0] : and(...axisFree);
  const [rows, [detector] = [{ n: 0 }], [humanDraft] = [{ n: 0 }]] = await Promise.all([
    db
      .select({ status: issues.status, n: count() })
      .from(issues)
      .where(base)
      .groupBy(issues.status),
    db
      .select({ n: count() })
      .from(issues)
      .where(and(base, buildOriginCondition('detector'))),
    db
      .select({ n: count() })
      .from(issues)
      .where(and(base, eq(issues.status, 'draft'), buildOriginCondition('human'))),
  ]);
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = Number(r.n);
  return { byStatus, detector: Number(detector?.n ?? 0), humanDraft: Number(humanDraft?.n ?? 0) };
}

const coerceArray = <T>(v: T | T[] | undefined): T[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

export type { IssueSort } from './sort.js';
export { issueSortValues } from './sort.js';

const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    status: z
      .union([z.enum(issueStatuses), z.array(z.enum(issueStatuses))])
      .optional()
      .transform(coerceArray),
    statusNot: z
      .union([z.enum(issueStatuses), z.array(z.enum(issueStatuses))])
      .optional()
      .transform(coerceArray),
    priority: z
      .union([z.enum(issuePriorities), z.array(z.enum(issuePriorities))])
      .optional()
      .transform(coerceArray),
    label: z
      .union([z.uuid(), z.array(z.uuid())])
      .optional()
      .transform(coerceArray),
    module: z
      .union([z.string().trim().min(1), z.array(z.string().trim().min(1))])
      .optional()
      .transform(coerceArray),
    assignee: z.uuid().optional(),
    createdBy: z.union([z.uuid(), z.literal('agent')]).optional(),
    origin: z.enum(['detector', 'human']).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(issueSortValues).optional().default('createdAt:desc'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    withAgentSessions: z.coerce.boolean().optional().default(false),
    withCost: z.coerce.boolean().optional().default(false),
    withFailureInfo: z.coerce.boolean().optional().default(false),
    withPipelineHealth: z.coerce.boolean().optional().default(false),
    withBuckets: z.coerce.boolean().optional().default(false),
    withDependencies: z.coerce.boolean().optional().default(false),
    withModules: z.coerce.boolean().optional().default(false),
    /** ISS-1237 — archived issues are out of search unless asked for, in the page, total and buckets alike. */
    includeArchived: z.stringbool().optional(),
  })
  .strict();

const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = () =>
  new HTTPException(403, { message: 'not a project member', cause: { code: 'FORBIDDEN' } });

export function issueCostRollupQuery(issueIds: string[]) {
  const pairs = db
    .selectDistinct({
      issueId: jobs.issueId,
      sessionId: jobs.agentSessionId,
    })
    .from(jobs)
    .where(and(inArray(jobs.issueId, issueIds), isNotNull(jobs.agentSessionId)))
    .as('issue_sessions');
  return db
    .select({
      issueId: pairs.issueId,
      estimatedCost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
    })
    .from(pairs)
    .innerJoin(usageRecords, usageSessionMatch(sql`= ${pairs.sessionId}::text`))
    .groupBy(pairs.issueId);
}

async function sumCostByIssue(issueIds: string[]): Promise<Map<string, number>> {
  if (issueIds.length === 0) return new Map();
  const rows = await issueCostRollupQuery(issueIds);
  return new Map(rows.map((r) => [r.issueId as string, r.estimatedCost]));
}

export async function jobHistoryForStep(issueId: string, step: JobType) {
  return db
    .select({
      jobId: jobs.id,
      status: jobs.status,
      model: jobs.modelUsed,
      startedAt: jobs.dispatchedAt,
      finishedAt: jobs.finishedAt,
      estTokens: jobs.promptInputTokenEst,
      tokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
      cost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
    })
    .from(jobs)
    .leftJoin(usageRecords, usageSessionMatch(sql`= ${jobs.agentSessionId}::text`))
    .where(and(eq(jobs.issueId, issueId), eq(jobs.type, step)))
    .groupBy(jobs.id)
    .orderBy(sql`coalesce(${jobs.dispatchedAt}, ${jobs.queuedAt}) desc`);
}

/**
 * ISS-700 — the most recent failed job per issue, in ONE grouped query, to
 * back the issues-list row's Failed-badge tooltip. Mirrors `sumCostByIssue`'s
 * shape/convention exactly. `selectDistinctOn` requires the leading ORDER BY
 * column to match the DISTINCT ON column (`issueId`); `desc(finishedAt)` then
 * picks the newest failed job per issue.
 */
async function latestFailedJobByIssue(issueIds: string[]): Promise<
  Map<
    string,
    {
      failedStep: string;
      failureReason: string | null;
      failureKind: string | null;
      failedAt: string;
    }
  >
> {
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

export const searchRoutes = new Hono<{ Variables: AuthVars }>();
searchRoutes.use('*', requireAuth(), assertEmailVerified());

searchRoutes.get(
  '/:id/issues/search',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', searchQuerySchema, (r) => {
    if (!r.success) throw queryBadRequest(searchQuerySchema, r.error);
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden();

    const conditions = [eq(issues.projectId, projectId)];
    const axisFree = [eq(issues.projectId, projectId)];
    const both = (c: SQL) => {
      conditions.push(c);
      axisFree.push(c);
    };

    for (const side of issueArchiveSide(q.includeArchived)) both(side);
    if (q.q) {
      both(buildIssueSearchCondition(q.q));
    }
    if (q.status && q.status.length > 0) {
      conditions.push(inArray(issues.status, q.status));
    }
    if (q.statusNot && q.statusNot.length > 0) {
      conditions.push(notInArray(issues.status, q.statusNot));
    }
    if (q.priority && q.priority.length > 0) {
      both(inArray(issues.priority, q.priority));
    }
    if (q.assignee) {
      both(eq(issues.assigneeId, q.assignee));
    }
    if (q.createdBy) {
      both(buildCreatedByCondition(q.createdBy));
    }
    if (q.origin) {
      conditions.push(buildOriginCondition(q.origin));
    }
    if (q.category) {
      both(eq(issues.category, q.category));
    }
    if (q.label && q.label.length > 0) {
      const labelIds = q.label;
      both(
        exists(
          db
            .select({ one: sql`1` })
            .from(issueLabels)
            .where(and(eq(issueLabels.issueId, issues.id), inArray(issueLabels.labelId, labelIds))),
        ),
      );
    }

    if (q.module && q.module.length > 0) {
      const moduleIds = await resolveModuleIdsTolerant(projectId, q.module);
      if (moduleIds.length === 0) {
        return c.json(listResponse(c, [], 0, { limit: q.limit, offset: q.offset }));
      }
      both(
        exists(
          db
            .select({ one: sql`1` })
            .from(issueLabels)
            .where(
              and(eq(issueLabels.issueId, issues.id), inArray(issueLabels.labelId, moduleIds)),
            ),
        ),
      );
    }

    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(issues).where(where);

    const buckets = q.withBuckets ? await countBuckets(axisFree) : null;

    const rows = await issueListPageQuery({
      where,
      orderBy: buildIssueOrderBy(q.sort),
      limit: q.limit,
      offset: q.offset,
      matchedFields: q.q ? matchedSearchFieldsSql(q.q) : null,
    });

    const total = Number(n);

    const searchPrefix = await activeIssuePrefix(projectId);
    let serialized: Record<string, unknown>[] = rows.map((r) => ({
      ...serializeRestListRow(r, searchPrefix),
    }));

    if (q.withCost && serialized.length > 0) {
      const costMap = await sumCostByIssue(serialized.map((r) => r.id as string));
      serialized = serialized.map((r) => ({
        ...r,
        estimatedCost: costMap.get(r.id as string) ?? 0,
      }));
    }

    if (q.withFailureInfo && serialized.length > 0) {
      const failMap = await latestFailedJobByIssue(serialized.map((r) => r.id as string));
      serialized = serialized.map((r) => ({
        ...r,
        failureInfo: failMap.get(r.id as string) ?? null,
      }));
    }

    if (q.withPipelineHealth && serialized.length > 0) {
      const healthMap = await safeHydratePipelineHealthForIssues(
        projectId,
        serialized.map((r) => r.id as string),
      );
      serialized = serialized.map((r) => ({
        ...r,
        pipelineHealth: healthMap.get(r.id as string) ?? { stage: r.status },
      }));
    }

    if (q.withModules && serialized.length > 0) {
      const moduleMap = await listModulesForIssues(serialized.map((r) => r.id as string));
      serialized = serialized.map((r) => ({
        ...r,
        modules: moduleMap.get(r.id as string) ?? [],
      }));
    }

    if (q.withDependencies && serialized.length > 0) {
      const depMap = await loadIssueDependencyEdgesForIssues(
        serialized.map((r) => r.id as string),
        projectId,
      );
      serialized = serialized.map((r) => ({
        ...r,
        dependencies: depMap.get(r.id as string) ?? { outgoing: [], incoming: [] },
      }));
    }

    if (serialized.length > 0) {
      const creatorMap = await hydrateCreatorsForIssues(
        serialized.map((r) => ({ id: r.id as string, createdById: r.createdById as string })),
      );
      serialized = serialized.map((r) => ({
        ...r,
        ...creatorMap.get(r.id as string),
      }));
    }

    const withBuckets = <T>(env: T) => (buckets ? { ...env, buckets } : env);

    if (!q.withAgentSessions || serialized.length === 0) {
      return c.json(withBuckets(listResponse(c, serialized, total, q)));
    }

    const ids = serialized.map((r) => r.id as string);
    const [map, heldMap] = await Promise.all([
      hydrateAgentSessionsForIssues(projectId, ids),
      hydrateHeldForIssues(ids),
    ]);
    return c.json(
      withBuckets(
        listResponse(
          c,
          serialized.map((r) => {
            const bucket = map.get(r.id as string);
            return {
              ...r,
              agentSessions: bucket?.agentSessions ?? [],
              agentStatus: bucket?.agentStatus ?? null,
              held: heldMap.get(r.id as string),
            };
          }),
          total,
          q,
        ),
      ),
    );
  },
);
