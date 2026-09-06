import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, like, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { activityLog, issues } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import type { ActorAgency } from './actor-agency.js';
import { type ActorRef, type ActorType, actorKey, type ResolvedActor } from './actor-identity.js';
import { resolveActors } from './actor-resolution.js';

const ACTIVITY_TYPES = ['issue', 'comment', 'member'] as const;

const activityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.date().optional(),
    type: z.enum(ACTIVITY_TYPES).optional(),
  })
  .strict();

const perIssueQuerySchema = activityQuerySchema.omit({ type: true });
const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

// cm:why one column list, three readers. It was written out three times and `actor_agency` would have had to be added to each — the ISS-927 read path is exactly the kind of column a copy quietly misses, and a feed that reads `human` because one query forgot to select the field is indistinguishable from a feed that is right.
const ACTIVITY_ROW_COLUMNS = {
  id: activityLog.id,
  issueId: activityLog.issueId,
  action: activityLog.action,
  actorType: activityLog.actorType,
  actorAgency: activityLog.actorAgency,
  actorId: activityLog.actorId,
  payload: activityLog.payload,
  createdAt: activityLog.createdAt,
} as const;

type ActivityRow = {
  id: string;
  issueId: string;
  action: string;
  actorType: string;
  actorAgency: ActorAgency;
  actorId: string;
  payload: unknown;
  createdAt: Date;
};

type ActivityRowWithActor = ActivityRow & { actor: ResolvedActor | null };

// cm:guard `isAgent` is decided PER ROW, not per actor, and that is why it is applied here rather than inside `resolveActors`. That resolver's map is keyed on `(type, id)` and one person's rows legitimately differ: the same user id is a human at the keyboard on one row and a job or session token on the next. Folding agency into the map would let the last row of a batch decide the marker for all of them.
function isAgentForRow(row: ActivityRow, resolved: ResolvedActor): boolean {
  // cm:guard the `||` is what protects history, and removing it silently rewrites the past. Every row written before migration 0193 carries this column's `'human'` DEFAULT — runner writes included — so reading the column ALONE would drop the agent marker across all of it. The type test is the pre-column answer and stays as the floor; the column can only ever add agents, never remove one. This is the narrowing that lets the read path ship without reversing the owner's 2026-09-02 deferral, which existed for exactly this risk.
  return row.actorAgency === 'agent' || resolved.isAgent;
}

// cm:guard the raw `actorType`/`actorId` stay on the row alongside `actor`, and an unresolvable pair leaves `actor` null rather than a placeholder — the FE renders the raw type in that case, so inventing an `Unknown` actor here would hide a broken reference behind something that looks resolved.
async function attachActors(rows: ActivityRow[]): Promise<ActivityRowWithActor[]> {
  const refs: ActorRef[] = [];
  for (const r of rows) {
    if ((r.actorType === 'user' || r.actorType === 'device') && r.actorId) {
      refs.push({ type: r.actorType as ActorType, id: r.actorId });
    }
  }
  const resolved = await resolveActors(refs);
  return rows.map((r) => {
    const base =
      (r.actorType === 'user' || r.actorType === 'device') && r.actorId
        ? (resolved.get(actorKey(r.actorType as ActorType, r.actorId)) ?? null)
        : null;
    return { ...r, actor: base ? { ...base, isAgent: isAgentForRow(r, base) } : null };
  });
}

function envelope(rows: ActivityRowWithActor[], limit: number) {
  const last = rows.at(-1);
  return {
    items: rows,
    nextBefore: rows.length === limit && last ? last.createdAt.toISOString() : null,
  };
}

export const issueActivityRoutes = new Hono<{ Variables: AuthVars }>();
issueActivityRoutes.use('*', requireAuth(), assertEmailVerified());

issueActivityRoutes.get(
  '/:id/activity',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', perIssueQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const { limit, before } = c.req.valid('query');
    const userId = c.get('userId');

    const [issue] = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const conditions = [eq(activityLog.issueId, issueId)];
    if (before) conditions.push(lt(activityLog.createdAt, before));
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    const rows = await db
      .select({
        ...ACTIVITY_ROW_COLUMNS,
      })
      .from(activityLog)
      .where(where)
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);

    const withActors = await attachActors(rows as ActivityRow[]);
    return c.json(envelope(withActors, limit));
  },
);

const verdictSchema = z.enum(['approve', 'reject']);
const evaluateBodySchema = z
  .object({
    verdict: verdictSchema,
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

const activityIdParamSchema = z.object({ id: z.uuid(), activityId: z.uuid() });

async function loadActivity(activityId: string) {
  const [row] = await db
    .select({
      id: activityLog.id,
      issueId: activityLog.issueId,
      payload: activityLog.payload,
      projectId: issues.projectId,
    })
    .from(activityLog)
    .innerJoin(issues, eq(issues.id, activityLog.issueId))
    .where(eq(activityLog.id, activityId))
    .limit(1);
  return row ?? null;
}

issueActivityRoutes.patch(
  '/:id/activity/:activityId/evaluate',
  zValidator('param', activityIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', evaluateBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId, activityId } = c.req.valid('param');
    const { verdict, note } = c.req.valid('json');
    const userId = c.get('userId');

    const activity = await loadActivity(activityId);
    if (!activity || activity.issueId !== issueId) throw notFound('activity not found');

    const access = await loadProjectAccess(activity.projectId, userId);
    assertProjectRole(access, 'member');

    const previous = (activity.payload as Record<string, unknown> | null) ?? {};
    const nextPayload = {
      ...previous,
      evaluation: {
        verdict,
        note: note ?? null,
        evaluatedAt: new Date().toISOString(),
        evaluatedBy: userId,
      },
    };

    const [updated] = await db
      .update(activityLog)
      .set({ payload: nextPayload })
      .where(eq(activityLog.id, activityId))
      .returning({
        ...ACTIVITY_ROW_COLUMNS,
      });
    if (!updated) throw notFound('activity not found');
    const [withActor] = await attachActors([updated as ActivityRow]);
    return c.json(withActor);
  },
);

issueActivityRoutes.delete(
  '/:id/activity/:activityId',
  zValidator('param', activityIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId, activityId } = c.req.valid('param');
    const userId = c.get('userId');

    const activity = await loadActivity(activityId);
    if (!activity || activity.issueId !== issueId) throw notFound('activity not found');

    const access = await loadProjectAccess(activity.projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    await db.delete(activityLog).where(eq(activityLog.id, activityId));
    return c.body(null, 204);
  },
);

export const projectActivityRoutes = new Hono<{ Variables: AuthVars }>();
projectActivityRoutes.use('*', requireAuth(), assertEmailVerified());

projectActivityRoutes.get(
  '/:id/activity',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', activityQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const { limit, before, type } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const conditions = [eq(issues.projectId, projectId)];
    if (before) conditions.push(lt(activityLog.createdAt, before));
    if (type) conditions.push(like(activityLog.action, `${type}.%`));

    const rows = await db
      .select({
        ...ACTIVITY_ROW_COLUMNS,
      })
      .from(activityLog)
      .innerJoin(issues, eq(issues.id, activityLog.issueId))
      .where(and(...conditions))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);

    const withActors = await attachActors(rows as ActivityRow[]);
    return c.json(envelope(withActors, limit));
  },
);

// cm:why exported for the test and nothing else. `attachActors` is where the ISS-927 agent marker is decided, and reaching it through a route would need a DB, a project, a member and a JWT to assert a pure mapping — a cost that buys nothing, since the route's own auth and query are covered elsewhere.
export const __testing = { attachActors };
