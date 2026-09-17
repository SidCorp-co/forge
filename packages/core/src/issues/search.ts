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
import {
  buildCreatedByCondition,
  buildOriginCondition,
  hydrateCreatorsForIssues,
} from './creator.js';
import { loadIssueDependencyEdgesForIssues } from './dependency-read.js';
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

// cm:guard counts come from the caller's own narrowing minus status and origin, never from a fresh `where`. The tabs map statuses to buckets on the client, through the contracts label axis, so this returns raw per-status numbers and no bucket names: a second copy of that mapping here is exactly the drift the axis exists to prevent.
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
    // cm:why the web list's default "all open" view is built on this — it hides drafts by exclusion rather than by enumerating every other status, so a status added later shows up there without a change here (ISS-236)
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
    // cm:why ISS-593 — `module` takes a NAME or a uuid while `label` above stays uuid-only: a module is the thing a person types, and web-v2 (ISS-594) sends the name it displays
    module: z
      .union([z.string().trim().min(1), z.array(z.string().trim().min(1))])
      .optional()
      .transform(coerceArray),
    assignee: z.uuid().optional(),
    // cm:why a uuid here means that person's non-agent-channel rows ONLY — see buildCreatedByCondition
    createdBy: z.union([z.uuid(), z.literal('agent')]).optional(),
    // cm:why splits unreviewed detector output from work someone chose to do — distinct from createdBy=agent, which is a display concern and counts `mcp` too
    origin: z.enum(['detector', 'human']).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(issueSortValues).optional().default('createdAt:desc'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    withAgentSessions: z.coerce.boolean().optional().default(false),
    // cm:why opt-in because the rollup is one extra grouped query per page; it replaced the web list's per-row cost-summary N+1 (ISS-437)
    withCost: z.coerce.boolean().optional().default(false),
    // cm:why same grouped-query shape and same opt-in reason as withCost above; it backs the list row's Failed-badge tooltip (ISS-700)
    withFailureInfo: z.coerce.boolean().optional().default(false),
    // cm:why opt-in like withCost/withFailureInfo: it costs ~9 batched round trips, and the callers that need it are the board and the issues list, where a queued-but-undispatched issue otherwise renders as actively worked
    withPipelineHealth: z.coerce.boolean().optional().default(false),
    // cm:why opt-in like the hydrators above: it is two grouped reads, and only the issues list needs them. What it returns is a count PER STATUS plus the two origin counts, never a count per tab — the tabs are the client's mapping (contracts `statusesForLabels`), and a second copy of that mapping here is the drift the label axis exists to prevent.
    withBuckets: z.coerce.boolean().optional().default(false),
    // cm:why opt-in like withCost/withFailureInfo: ONE grouped read of `issue_dependencies` over the page replaced the list row's per-row `GET /issues/:id/dependencies` — 25 requests a page at ISSUES_PAGE_SIZE (ISS-1017)
    withDependencies: z.coerce.boolean().optional().default(false),
    // cm:why ISS-594 — the ONLY way a list row learns its modules: this response serializes a projection of the `issues` row, which has no label columns, and the alternative for web-v2's module cell was one `GET /issues/:id` per row
    withModules: z.coerce.boolean().optional().default(false),
  })
  .strict();

const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = () =>
  new HTTPException(403, { message: 'not a project member', cause: { code: 'FORBIDDEN' } });

/**
 * ISS-437 — per-issue estimated cost for one page of issues, in ONE grouped
 * query. Session resolution mirrors `GET /api/issues/:id/cost-summary`
 * (extras-routes.ts): DISTINCT (issue_id, agent_session_id) pairs from `jobs`,
 * then `usage_records.estimated_cost` summed over those session ids per issue
 * — the DISTINCT keeps a session that backed several jobs of the same issue
 * from multiplying its cost (the fan-out the cost-summary route fixed in
 * ISS-308 B4). `usage_records.session_id` is TEXT holding a canonical lowercase
 * uuid, so the `uuid` side carries the `::text` and the indexed column is
 * compared as it is stored (ISS-1015).
 *
 * Exported so the plan assertion in `tests/integration/usage-session-index.test.ts`
 * explains the statement this route sends rather than a likeness of it. That is
 * not a convenience: ISS-1015's own criterion was taken against a hand-written
 * predicate whose `p.session_id` was qualified, so a green plan-shape assertion
 * sat beside a statement Postgres refused on every execution (ISS-1081).
 */
// cm:guard the subquery selects `jobs.agentSessionId` ITSELF and the `::text` rides on the join, rather than the subquery aliasing a cast expression. An `sql`.as('session_id') field renders in the outer query as the BARE alias, so the ON clause emitted `"usage_records"."session_id" = "session_id"` — a name both tables carry, which Postgres refuses as ambiguous, and which took the Issues list down on every non-empty project (ISS-1081). A real column is qualified by drizzle to `"issue_sessions"."agent_session_id"`. Renaming the alias would end the ambiguity and leave the reference unqualified, which is the same defect waiting for the next column of that name.
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

/**
 * ISS-1015 — one step's job history for an issue, with the tokens and cost each
 * job actually spent. The usage is keyed on `jobs.agent_session_id`, never on
 * the job id: `usage_records.session_id` holds an `agent_sessions.id`, and the
 * route that joined it to `jobs.id` priced every job at zero. TEXT column,
 * canonical lowercase uuid, so the right-hand side renders as text and the join
 * is plain equality on the indexed column.
 *
 * It lives here rather than in `routes.ts` because that file is at its
 * module-reach ceiling (`no-coordinator-blob`): the query belongs to the module
 * that owns the reading, not to the file that serves it.
 */
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
  // cm:edge contract -> packages/core/src/issues/routes.ts — the two project issue lists refuse an unknown parameter in ONE shape; this route was already strict while its sibling silently stripped, and a caller reading two refusal vocabularies on one surface is what made ISS-991's wrong inference reasonable
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
    // cm:why the tab counts are built from the SAME narrowing with only the two axes the tabs select — status and origin — left out, so a count and the list beneath it can disagree about which tab a row belongs to and about nothing else. A second query with filters of its own is how a tab says 5 and shows 4.
    const axisFree = [eq(issues.projectId, projectId)];
    const both = (c: SQL) => {
      conditions.push(c);
      axisFree.push(c);
    };

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
      // cm:guard an unresolvable module short-circuits to NO rows — falling through would drop the narrowing and hand the caller every issue in the project as "the module's issues"
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

    // cm:why ISS-960 — `matchedFields` appears ONLY when `q` was sent, so a caller can tell "this row matched on its acceptance criteria" from "this row was not searched for at all". ISS-1016 moved it into the query: this route no longer selects `description`, `plan` or `acceptanceCriteria`, so the only honest way to name the match is to have Postgres name it, with the same `ISSUE_SEARCH_FIELDS` order and the same wildcard escaping the predicate itself uses.
    // cm:why ISS-1016 — the page comes from `issueListPageQuery` and not from a `db.select()` here, so the plan `issue-list-index-plan-e2e.test.ts` EXPLAINs is the plan this handler runs
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

    // cm:guard an issue with no usage rows carries `estimatedCost: 0` and never a missing key — under `withCost=1` the field is always numeric, so a client cannot read "never ran" as "cost unknown" (ISS-437)
    if (q.withCost && serialized.length > 0) {
      const costMap = await sumCostByIssue(serialized.map((r) => r.id as string));
      serialized = serialized.map((r) => ({
        ...r,
        estimatedCost: costMap.get(r.id as string) ?? 0,
      }));
    }

    // cm:guard this block stays ABOVE the `withAgentSessions` early-return — move it below and the Failed-badge tooltip loses its data on exactly the callers that also ask for sessions (ISS-700)
    if (q.withFailureInfo && serialized.length > 0) {
      const failMap = await latestFailedJobByIssue(serialized.map((r) => r.id as string));
      serialized = serialized.map((r) => ({
        ...r,
        failureInfo: failMap.get(r.id as string) ?? null,
      }));
    }

    // cm:edge contract -> packages/web-v2/src/features/issues/types.ts — web re-types this payload rather than importing it, so a field added to `PipelineHealth` reaches the board and the list only once BOTH sides carry it
    // cm:guard graft `{ stage }` for every id the map omits, never `undefined` — a row whose health failed to derive must still answer "which stage", or the consumer cannot tell a degraded hydration from an issue with nothing queued
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

    // cm:guard every row gets the key when the flag is on, `[]` included — a row that omits it is indistinguishable from a row whose hydration failed, and the cell would render a module the issue does not have on the next page's cache hit
    if (q.withModules && serialized.length > 0) {
      const moduleMap = await listModulesForIssues(serialized.map((r) => r.id as string));
      serialized = serialized.map((r) => ({
        ...r,
        modules: moduleMap.get(r.id as string) ?? [],
      }));
    }

    // cm:guard every row gets the key when the flag is on, both arrays empty included — a row that omits it is indistinguishable from one whose hydration failed, and the badges would render the previous page's relations on the next cache hit (ISS-1017, the ISS-437 rule)
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

    // cm:why no opt-in flag here, unlike withCost/withFailureInfo — every list/detail surface needs the creator fields
    if (serialized.length > 0) {
      const creatorMap = await hydrateCreatorsForIssues(
        serialized.map((r) => ({
          id: r.id as string,
          createdById: r.createdById as string,
          createdVia: r.createdVia as string | null,
        })),
      );
      serialized = serialized.map((r) => ({
        ...r,
        ...creatorMap.get(r.id as string),
      }));
    }

    // cm:why `buckets` rides the envelope rather than a second endpoint: the numbers a tab shows and the rows under it are then read in one request, from one narrowing, and cannot describe different moments.
    const withBuckets = <T>(env: T) => (buckets ? { ...env, buckets } : env);

    if (!q.withAgentSessions || serialized.length === 0) {
      return c.json(withBuckets(listResponse(c, serialized, total, q)));
    }

    const map = await hydrateAgentSessionsForIssues(
      projectId,
      serialized.map((r) => r.id as string),
    );
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
            };
          }),
          total,
          q,
        ),
      ),
    );
  },
);
