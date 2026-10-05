import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { type ActivityRow, listIssueActivity, listProjectActivity } from './activity-read.js';
import { type ActorRef, type ActorType, actorKey, type ResolvedActor } from './actor-identity.js';
import { resolveActors } from './actor-resolution.js';
import {
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from './issue-route-ref.js';

const ACTIVITY_TYPES = ['issue', 'comment', 'member'] as const;

const activityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.coerce.date().optional(),
    type: z.enum(ACTIVITY_TYPES).optional(),
  })
  .strict();

const perIssueQuerySchema = activityQuerySchema.omit({ type: true }).extend({
  projectId: projectScopeQuerySchema.shape.projectId,
});

type ActivityRowWithActor = ActivityRow & { actor: ResolvedActor | null };

function isAgentForRow(row: ActivityRow, resolved: ResolvedActor): boolean {
  return row.actorAgency === 'agent' || resolved.isAgent;
}

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
  zValidator('param', issueRouteIdParamSchema),
  zValidator('query', perIssueQuerySchema),
  async (c) => {
    const { id: rawId } = c.req.valid('param');
    const { limit, before, projectId: projectIdQuery } = c.req.valid('query');
    const userId = c.get('userId');

    const issue = await resolveIssueRouteRef(rawId, projectIdQuery, userId);
    const issueId = issue.id;

    const rows = await listIssueActivity(issueId, limit, before);
    const withActors = await attachActors(rows);
    return c.json(envelope(withActors, limit));
  },
);
// cm:guard ISS-96 — kernel evidence is kept as written for as long as its issue is: the activity

export const projectActivityRoutes = new Hono<{ Variables: AuthVars }>();
projectActivityRoutes.use('*', requireAuth(), assertEmailVerified());

projectActivityRoutes.get(
  '/:id/activity',
  zValidator('param', idParamSchema),
  zValidator('query', activityQuerySchema),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const { limit, before, type } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const rows = await listProjectActivity(projectId, limit, before, type);
    const withActors = await attachActors(rows);
    return c.json(envelope(withActors, limit));
  },
);
