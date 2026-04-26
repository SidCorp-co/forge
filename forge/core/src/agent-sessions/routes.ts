import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentSessionStatuses, agentSessions } from '../db/schema.js';
import { setTotalCount } from '../lib/pagination.js';
import { loadProjectAccess, type ProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { safeRecordActivity } from '../pipeline/activity.js';
import { deviceRoom, projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import {
  DEFAULT_PIPELINE_HEALTH,
  buildPipelineControl,
  buildPipelineHealth,
  normalisePipelineControl,
  type PipelineControl,
  type PipelineHealth,
  pipelineControlInputSchema,
  pipelineHealthInputSchema,
} from './pipeline-control-types.js';

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z
  .object({
    projectId: z.uuid().optional(),
    deviceId: z.uuid().optional(),
    status: z.enum(agentSessionStatuses).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const createSchema = z
  .object({
    projectId: z.uuid(),
    deviceId: z.uuid().nullable().optional(),
    title: z.string().max(500).nullable().optional(),
    repoPath: z.string().max(2000).nullable().optional(),
    claudeSessionId: z.string().max(500).nullable().optional(),
    metadata: z.unknown().optional(),
  })
  .strict();

const patchSchema = z
  .object({
    title: z.string().max(500).nullable().optional(),
    status: z.enum(agentSessionStatuses).optional(),
    claudeSessionId: z.string().max(500).nullable().optional(),
    repoPath: z.string().max(2000).nullable().optional(),
    messages: z.array(z.unknown()).optional(),
    usage: z.unknown().optional(),
    metadata: z.unknown().optional(),
    diff: z.unknown().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const pipelineTelemetrySchema = z
  .object({
    telemetry: z.unknown(),
  })
  .strict();

const relayBodySchema = z
  .object({
    event: z.string().min(1).max(200),
    data: z.unknown(),
  })
  .strict();

const desktopStatusSchema = z
  .object({
    sessionId: z.uuid(),
    status: z.enum(agentSessionStatuses),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

function isOwnerOrAdmin(access: ProjectAccess, userId: string): boolean {
  if (access.ownerId === userId) return true;
  return access.role === 'owner' || access.role === 'admin';
}

function extractIssueId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>).issueId;
  if (typeof raw !== 'string') return null;
  // RFC 4122 UUID — guard against malformed metadata to avoid FK errors
  // even though safeRecordActivity would swallow them.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return null;
  return raw;
}

function broadcastSession(
  session: { id: string; projectId: string; deviceId: string | null; status: string },
  event: string,
  extra: Record<string, unknown> = {},
): void {
  const payload = {
    event,
    data: {
      sessionId: session.id,
      projectId: session.projectId,
      deviceId: session.deviceId,
      status: session.status,
      ...extra,
    },
  };
  roomManager.publish(projectRoom(session.projectId), payload);
  if (session.deviceId) roomManager.publish(deviceRoom(session.deviceId), payload);
}

export const agentSessionRoutes = new Hono<{ Variables: AuthVars }>();
agentSessionRoutes.use('*', requireAuth(), assertEmailVerified());

// Static path mounted before `:id` to avoid uuid validator collisions.
agentSessionRoutes.post(
  '/desktop/status',
  zValidator('json', desktopStatusSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { sessionId, status, note } = c.req.valid('json');
    const userId = c.get('userId');

    const [existing] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .limit(1);
    if (!existing) throw notFound('agent session not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const [updated] = await db
      .update(agentSessions)
      .set({ status, updatedAt: new Date() })
      .where(eq(agentSessions.id, sessionId))
      .returning();
    if (!updated) throw notFound('agent session not found');

    broadcastSession(updated, 'agent-session.status', { note: note ?? null });
    return c.json(updated);
  },
);

agentSessionRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, deviceId, status, page, pageSize } = c.req.valid('query');
    const userId = c.get('userId');

    if (!projectId && !deviceId) {
      throw badRequest({ message: 'projectId or deviceId is required' });
    }

    if (projectId) {
      const access = await loadProjectAccess(projectId, userId);
      if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');
    }

    const conditions: SQL[] = [];
    if (projectId) conditions.push(eq(agentSessions.projectId, projectId));
    if (deviceId) conditions.push(eq(agentSessions.deviceId, deviceId));
    if (status) conditions.push(eq(agentSessions.status, status));

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [totalRow] = await db
      .select({ n: count() })
      .from(agentSessions)
      .where(where ?? undefined);
    setTotalCount(c, totalRow?.n ?? 0);

    const rows = await db
      .select()
      .from(agentSessions)
      .where(where ?? undefined)
      .orderBy(desc(agentSessions.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return c.json(rows);
  },
);

agentSessionRoutes.post(
  '/',
  zValidator('json', createSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(input.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const [inserted] = await db
      .insert(agentSessions)
      .values({
        projectId: input.projectId,
        userId,
        deviceId: input.deviceId ?? null,
        title: input.title ?? null,
        repoPath: input.repoPath ?? null,
        claudeSessionId: input.claudeSessionId ?? null,
        metadata: (input.metadata as never) ?? null,
      })
      .returning();
    if (!inserted) throw new Error('agent_sessions: insert returned no row');

    broadcastSession(inserted, 'agent-session.created');
    return c.json(inserted, 201);
  },
);

agentSessionRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
    if (!row) throw notFound('agent session not found');

    const access = await loadProjectAccess(row.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    return c.json(row);
  },
);

agentSessionRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', patchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const [existing] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!existing) throw notFound('agent session not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) updates.title = patch.title;
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.claudeSessionId !== undefined) updates.claudeSessionId = patch.claudeSessionId;
    if (patch.repoPath !== undefined) updates.repoPath = patch.repoPath;
    if (patch.messages !== undefined) updates.messages = patch.messages;
    if (patch.usage !== undefined) updates.usage = patch.usage;
    if (patch.metadata !== undefined) updates.metadata = patch.metadata;
    if (patch.diff !== undefined) updates.diff = patch.diff;

    const [updated] = await db
      .update(agentSessions)
      .set(updates)
      .where(eq(agentSessions.id, id))
      .returning();
    if (!updated) throw notFound('agent session not found');

    if (patch.status !== undefined && patch.status !== existing.status) {
      broadcastSession(updated, 'agent-session.status');
    } else {
      broadcastSession(updated, 'agent-session.updated');
    }
    return c.json(updated);
  },
);

agentSessionRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [existing] = await db
      .select({ id: agentSessions.id, projectId: agentSessions.projectId, deviceId: agentSessions.deviceId, status: agentSessions.status })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!existing) throw notFound('agent session not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    if (access.ownerId !== userId && access.role !== 'owner' && access.role !== 'admin') {
      throw forbidden('insufficient permission');
    }

    await db.delete(agentSessions).where(eq(agentSessions.id, id));
    broadcastSession(existing, 'agent-session.deleted');
    return c.body(null, 204);
  },
);

agentSessionRoutes.post(
  '/:id/relay',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', relayBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { event, data } = c.req.valid('json');
    const userId = c.get('userId');

    const [existing] = await db
      .select({ id: agentSessions.id, projectId: agentSessions.projectId, deviceId: agentSessions.deviceId, status: agentSessions.status })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!existing) throw notFound('agent session not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    broadcastSession(existing, `agent-session.relay.${event}`, { payload: data });
    return c.json({ relayed: true });
  },
);

agentSessionRoutes.get(
  '/:id/pipeline-control',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db
      .select({
        id: agentSessions.id,
        projectId: agentSessions.projectId,
        pipelineControl: agentSessions.pipelineControl,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!row) throw notFound('agent session not found');

    const access = await loadProjectAccess(row.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    return c.json(normalisePipelineControl(row.pipelineControl));
  },
);

agentSessionRoutes.post(
  '/:id/pipeline-control',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', pipelineControlInputSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const [existing] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!existing) throw notFound('agent session not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    // Pause/resume is a privileged operation — only owner or admin role.
    // Plain members can read state but cannot mutate it.
    if (!isOwnerOrAdmin(access, userId)) throw forbidden('owner or admin role required');

    const prev = existing.pipelineControl as PipelineControl | null;
    const merged = buildPipelineControl(prev, input, userId);

    const [updated] = await db
      .update(agentSessions)
      .set({ pipelineControl: merged, updatedAt: new Date() })
      .where(eq(agentSessions.id, id))
      .returning();
    if (!updated) throw notFound('agent session not found');

    broadcastSession(updated, 'agent-session.pipeline-control', {
      control: merged,
      paused: merged.paused,
    });

    // Best-effort audit. activity_log requires an issue FK; only record when
    // the session is bound to an issue. safeRecordActivity swallows errors.
    const issueId = extractIssueId(existing.metadata);
    if (issueId) {
      await safeRecordActivity({
        issueId,
        actor: { type: 'user', id: userId },
        action: 'agent-session.pipelineControl.changed',
        before: prev ?? undefined,
        after: merged,
        payload: {
          sessionId: id,
          paused: merged.paused,
          reason: merged.reason,
        },
      });
    }

    return c.json(merged);
  },
);

agentSessionRoutes.get(
  '/:id/pipeline-health',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db
      .select({
        id: agentSessions.id,
        projectId: agentSessions.projectId,
        pipelineHealth: agentSessions.pipelineHealth,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!row) throw notFound('agent session not found');

    const access = await loadProjectAccess(row.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    return c.json((row.pipelineHealth as PipelineHealth | null) ?? DEFAULT_PIPELINE_HEALTH);
  },
);

// TODO(EPIC-3 phase B / ISS-271): once Epic 2 introduces device-principal
// runners, gate this POST behind a device-or-admin middleware. For Phase A any
// project member may write — sufficient because health is informational.
agentSessionRoutes.post(
  '/:id/pipeline-health',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', pipelineHealthInputSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const [existing] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!existing) throw notFound('agent session not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const merged = buildPipelineHealth(existing.pipelineHealth as PipelineHealth | null, input);

    const [updated] = await db
      .update(agentSessions)
      .set({ pipelineHealth: merged, updatedAt: new Date() })
      .where(eq(agentSessions.id, id))
      .returning();
    if (!updated) throw notFound('agent session not found');

    broadcastSession(updated, 'agent-session.pipeline-health', { health: merged });
    return c.json(merged);
  },
);

agentSessionRoutes.get(
  '/:id/pipeline-telemetry',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db
      .select({
        id: agentSessions.id,
        projectId: agentSessions.projectId,
        pipelineTelemetry: agentSessions.pipelineTelemetry,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!row) throw notFound('agent session not found');

    const access = await loadProjectAccess(row.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    return c.json(row.pipelineTelemetry ?? null);
  },
);

agentSessionRoutes.post(
  '/:id/pipeline-telemetry',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', pipelineTelemetrySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { telemetry } = c.req.valid('json');
    const userId = c.get('userId');

    const [existing] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!existing) throw notFound('agent session not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const [updated] = await db
      .update(agentSessions)
      .set({ pipelineTelemetry: telemetry as never, updatedAt: new Date() })
      .where(eq(agentSessions.id, id))
      .returning();
    if (!updated) throw notFound('agent session not found');

    broadcastSession(updated, 'agent-session.pipeline-telemetry', { telemetry });
    return c.json(telemetry);
  },
);
