import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, like, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { activityLog, issues } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  type ActorRef,
  type ActorType,
  type ResolvedActor,
  actorKey,
  resolveActors,
} from './actor-resolution.js';

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

type ActivityRow = {
  id: string;
  issueId: string;
  action: string;
  actorType: string;
  actorId: string;
  payload: unknown;
  createdAt: Date;
};

type ActivityRowWithActor = ActivityRow & { actor: ResolvedActor | null };

// ISS-519 — resolve each row's (actorType, actorId) to a display identity and
// attach it as `actor`. The raw actorType/actorId stay on the row for
// back-compat. Only the known actor types ('user' | 'device') are resolvable;
// any other value (defensive) leaves actor null and the FE falls back to the
// raw actorType.
async function attachActors(rows: ActivityRow[]): Promise<ActivityRowWithActor[]> {
  const refs: ActorRef[] = [];
  for (const r of rows) {
    if ((r.actorType === 'user' || r.actorType === 'device') && r.actorId) {
      refs.push({ type: r.actorType as ActorType, id: r.actorId });
    }
  }
  const resolved = await resolveActors(refs);
  return rows.map((r) => ({
    ...r,
    actor:
      (r.actorType === 'user' || r.actorType === 'device') && r.actorId
        ? (resolved.get(actorKey(r.actorType as ActorType, r.actorId)) ?? null)
        : null,
  }));
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
        id: activityLog.id,
        issueId: activityLog.issueId,
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        payload: activityLog.payload,
        createdAt: activityLog.createdAt,
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
        id: activityLog.id,
        issueId: activityLog.issueId,
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        payload: activityLog.payload,
        createdAt: activityLog.createdAt,
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
        id: activityLog.id,
        issueId: activityLog.issueId,
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        payload: activityLog.payload,
        createdAt: activityLog.createdAt,
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
