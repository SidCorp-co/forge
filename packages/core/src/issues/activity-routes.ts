import {
  KERNEL_RECORD_KINDS,
  type RecordEventRefusalCode,
  recordAction,
} from '@forge/contracts/record-events';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest, idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { deleteActivity, setActivityPayload } from './activity-log.js';
import {
  type ActivityRow,
  listIssueActivity,
  listProjectActivity,
  loadActivity,
} from './activity-read.js';
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
  zValidator('param', issueRouteIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', perIssueQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
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

const verdictSchema = z.enum(['approve', 'reject']);
const evaluateBodySchema = z
  .object({
    verdict: verdictSchema,
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

const activityIdParamSchema = z.object({ id: z.uuid(), activityId: z.uuid() });

const refuseRecord = refuser<RecordEventRefusalCode>('EVENT_REFUSED');

const KERNEL_RECORD_ACTIONS: ReadonlySet<string> = new Set(KERNEL_RECORD_KINDS.map(recordAction));

// cm:guard ISS-96 — kernel evidence is kept as written for as long as its issue is: the activity
// routes neither evaluate nor delete a verdict, transition, landing, park or correction row
function assertActivityMutable(action: string): void {
  if (!KERNEL_RECORD_ACTIONS.has(action)) return;
  throw refuseRecord(
    'KERNEL_RECORD_IMMUTABLE',
    `\`${action}\` is kernel evidence, kept as written for as long as its issue is, so it cannot be evaluated or deleted. Say what is wrong with it in a comment, or record a \`correction\` (\`POST /api/issues/:id/events\`).`,
  );
}

issueActivityRoutes.patch(
  '/:id/activity/:activityId/evaluate',
  zValidator('param', activityIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', evaluateBodySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: issueId, activityId } = c.req.valid('param');
    const { verdict, note } = c.req.valid('json');
    const userId = c.get('userId');

    const activity = await loadActivity(activityId);
    if (!activity || activity.issueId !== issueId) throw notFound('activity not found');

    const access = await loadProjectAccess(activity.projectId, userId);
    requireHeld(access, 'project.write');
    assertActivityMutable(activity.action);

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

    const updated = await setActivityPayload(activityId, nextPayload);
    if (!updated) throw notFound('activity not found');
    const [withActor] = await attachActors([updated]);
    return c.json(withActor);
  },
);

issueActivityRoutes.delete(
  '/:id/activity/:activityId',
  zValidator('param', activityIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: issueId, activityId } = c.req.valid('param');
    const userId = c.get('userId');

    const activity = await loadActivity(activityId);
    if (!activity || activity.issueId !== issueId) throw notFound('activity not found');

    const access = await loadProjectAccess(activity.projectId, userId);
    requireHeld(access, 'project.admin');
    assertActivityMutable(activity.action);

    await deleteActivity(activityId);
    return c.body(null, 204);
  },
);

export const projectActivityRoutes = new Hono<{ Variables: AuthVars }>();
projectActivityRoutes.use('*', requireAuth(), assertEmailVerified());

projectActivityRoutes.get(
  '/:id/activity',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', activityQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
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

export const __testing = { attachActors };
