import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, exists, inArray, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issueLabels, issuePriorities, issueStatuses, issues } from '../db/schema.js';
import { setTotalCount } from '../lib/pagination.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const coerceArray = <T>(v: T | T[] | undefined): T[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).optional(),
    status: z
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
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
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
    if (!access.role && access.ownerId !== userId) throw forbidden();

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
    if (q.priority && q.priority.length > 0) {
      conditions.push(inArray(issues.priority, q.priority));
    }
    if (q.assignee) {
      conditions.push(eq(issues.assigneeId, q.assignee));
    }
    if (q.label && q.label.length > 0) {
      const labelIds = q.label;
      conditions.push(
        exists(
          db
            .select({ one: sql`1` })
            .from(issueLabels)
            .where(
              and(eq(issueLabels.issueId, issues.id), inArray(issueLabels.labelId, labelIds)),
            ),
        ),
      );
    }

    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(issues).where(where);

    const rows = await db
      .select()
      .from(issues)
      .where(where)
      .orderBy(desc(issues.createdAt))
      .limit(q.limit)
      .offset(q.offset);

    setTotalCount(c, Number(n));
    return c.json(
      rows.map((r) => ({ ...r, displayId: `ISS-${(r as { issSeq: number }).issSeq}` })),
    );
  },
);
