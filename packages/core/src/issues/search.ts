import { zValidator } from '@hono/zod-validator';
import { and, count, eq, exists, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issueLabels, issuePriorities, issueStatuses, issues, jobs, usageRecords } from '../db/schema.js';
import { setTotalCount } from '../lib/pagination.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { hydrateAgentSessionsForIssues } from './agent-sessions-hydrator.js';
import { buildIssueOrderBy, issueSortValues } from './sort.js';

const coerceArray = <T>(v: T | T[] | undefined): T[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

export { issueSortValues } from './sort.js';
export type { IssueSort } from './sort.js';

const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    status: z
      .union([z.enum(issueStatuses), z.array(z.enum(issueStatuses))])
      .optional()
      .transform(coerceArray),
    // ISS-236 — exclude one or more statuses (used by the web list page to
    // hide drafts from the default "all open" view).
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
    assignee: z.uuid().optional(),
    category: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(issueSortValues).optional().default('createdAt:desc'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    // ISS-128 — opt-in hydration of `agentSessions[]` + derived `agentStatus`.
    withAgentSessions: z.coerce.boolean().optional().default(false),
    // ISS-437 — opt-in per-issue `estimatedCost` rollup (one grouped query for
    // the whole page; replaces the web list's per-row cost-summary N+1).
    withCost: z.coerce.boolean().optional().default(false),
  })
  .strict();

const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = () =>
  new HTTPException(403, { message: 'not a project member', cause: { code: 'FORBIDDEN' } });

/**
 * Escape ILIKE wildcard metacharacters so user input can't inject patterns.
 * Pair with an ESCAPE '\\' clause in the SQL.
 */
export function buildIlikePattern(q: string): string {
  const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);
  return `%${escaped}%`;
}

/**
 * ISS-437 — per-issue estimated cost for one page of issues, in ONE grouped
 * query. Session resolution mirrors `GET /api/issues/:id/cost-summary`
 * (extras-routes.ts): DISTINCT (issue_id, agent_session_id) pairs from `jobs`,
 * then `usage_records.estimated_cost` summed over those session ids per issue
 * — the DISTINCT keeps a session that backed several jobs of the same issue
 * from multiplying its cost (the fan-out the cost-summary route fixed in
 * ISS-308 B4). `usage_records.session_id` is a uuid-shaped TEXT column; the
 * regex guards the cast so a stray non-uuid value can't 500 the rollup.
 */
async function sumCostByIssue(issueIds: string[]): Promise<Map<string, number>> {
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
    .innerJoin(
      usageRecords,
      sql`${usageRecords.sessionId} ~ '^[0-9a-fA-F-]{36}$' AND ${usageRecords.sessionId}::uuid = ${pairs.sessionId}`,
    )
    .groupBy(pairs.issueId);
  return new Map(rows.map((r) => [r.issueId as string, r.estimatedCost]));
}

export const searchRoutes = new Hono<{ Variables: AuthVars }>();
searchRoutes.use('*', requireAuth(), assertEmailVerified());

searchRoutes.get(
  '/:id/issues/search',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', searchQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden();

    const conditions = [eq(issues.projectId, projectId)];

    if (q.q) {
      const pattern = buildIlikePattern(q.q);
      conditions.push(
        // biome-ignore lint/style/noNonNullAssertion: or() with two clauses is always defined
        or(
          sql`${issues.title} ILIKE ${pattern} ESCAPE '\\'`,
          sql`${issues.description} ILIKE ${pattern} ESCAPE '\\'`,
        )!,
      );
    }
    if (q.status && q.status.length > 0) {
      conditions.push(inArray(issues.status, q.status));
    }
    if (q.statusNot && q.statusNot.length > 0) {
      conditions.push(notInArray(issues.status, q.statusNot));
    }
    if (q.priority && q.priority.length > 0) {
      conditions.push(inArray(issues.priority, q.priority));
    }
    if (q.assignee) {
      conditions.push(eq(issues.assigneeId, q.assignee));
    }
    if (q.category) {
      conditions.push(eq(issues.category, q.category));
    }
    if (q.label && q.label.length > 0) {
      const labelIds = q.label;
      conditions.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(issueLabels)
            .where(and(eq(issueLabels.issueId, issues.id), inArray(issueLabels.labelId, labelIds))),
        ),
      );
    }

    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(issues).where(where);

    const orderBy = buildIssueOrderBy(q.sort);

    const rows = await db
      .select()
      .from(issues)
      .where(where)
      .orderBy(orderBy)
      .limit(q.limit)
      .offset(q.offset);

    setTotalCount(c, Number(n));

    let serialized: Record<string, unknown>[] = rows.map((r) => ({
      ...r,
      displayId: `ISS-${(r as { issSeq: number }).issSeq}`,
    }));

    // ISS-437 — attach `estimatedCost` when requested. Issues with no usage
    // (never ran, or sessions produced no usage rows) report 0, so the field
    // is always numeric when `withCost=1`.
    if (q.withCost && serialized.length > 0) {
      const costMap = await sumCostByIssue(serialized.map((r) => r.id as string));
      serialized = serialized.map((r) => ({
        ...r,
        estimatedCost: costMap.get(r.id as string) ?? 0,
      }));
    }

    if (!q.withAgentSessions || serialized.length === 0) {
      return c.json(serialized);
    }

    const map = await hydrateAgentSessionsForIssues(
      projectId,
      serialized.map((r) => r.id as string),
    );
    return c.json(
      serialized.map((r) => {
        const bucket = map.get(r.id as string);
        return {
          ...r,
          agentSessions: bucket?.agentSessions ?? [],
          agentStatus: bucket?.agentStatus ?? null,
        };
      }),
    );
  },
);
