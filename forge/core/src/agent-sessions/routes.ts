import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  agentSessionStatuses,
  agentSessions,
  devices,
  issues,
  projects,
} from '../db/schema.js';
import { buildChatPreamble, TOOL_REFERENCE } from '../lib/chat-preamble.js';
import { findAvailableDeviceForProject, resolveRepoPath } from '../lib/device-pool.js';
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

// === Static-path lifecycle routes (start / send / abort / build-prompt /
// prompt-built). All mounted BEFORE the `:id` handlers to avoid uuid validator
// collisions. The web UI calls these to drive an interactive Claude CLI
// conversation through the device-runner — the device speaks the legacy
// `agent:start | agent:send | agent:abort | agent:review | agent:reindex`
// vocabulary on its WS channel (forge/dev preserves these handlers from
// Strapi parity), so core just resolves a device, persists the session row,
// and publishes the right event into the device's room.

const startBodySchema = z
  .object({
    projectSlug: z.string().min(1).max(120),
    prompt: z.string().min(1).max(40_000).optional(),
    repoPath: z.string().max(2000).nullable().optional(),
    preBuilt: z.boolean().optional(),
    issueIds: z.array(z.uuid()).max(50).optional(),
    type: z.string().max(80).optional(),
    origin: z.string().max(40).optional(),
  })
  .strict();

const sendBodySchema = z
  .object({
    sessionId: z.uuid(),
    message: z.string().min(1).max(40_000),
    claudeSessionId: z.string().max(500).nullable().optional(),
    origin: z.string().max(40).optional(),
  })
  .strict();

const abortBodySchema = z
  .object({
    sessionId: z.uuid(),
  })
  .strict();

const buildPromptBodySchema = z
  .object({
    projectSlug: z.string().min(1).max(120),
    issueIds: z.array(z.uuid()).min(1).max(50),
  })
  .strict();

const promptBuiltBodySchema = z
  .object({
    requestId: z.string().min(1).max(120),
    prompt: z.string().max(80_000).optional(),
    error: z.string().max(2000).optional(),
  })
  .strict()
  .refine((o) => o.prompt !== undefined || o.error !== undefined, {
    message: 'prompt or error required',
  });

const MAX_RESUMABLE_CONTEXT = 600_000;

async function loadProjectBySlug(slug: string) {
  const [row] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      ownerId: projects.ownerId,
      repoPath: projects.repoPath,
      defaultDeviceId: projects.defaultDeviceId,
    })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return row ?? null;
}

async function findResumableSessionForIssue(
  issueId: string,
  deviceId: string | null,
): Promise<{
  id: string;
  claudeSessionId: string | null;
  messages: unknown;
  metadata: unknown;
  usage: unknown;
} | null> {
  const rows = await db
    .select({
      id: agentSessions.id,
      claudeSessionId: agentSessions.claudeSessionId,
      messages: agentSessions.messages,
      metadata: agentSessions.metadata,
      usage: agentSessions.usage,
      status: agentSessions.status,
    })
    .from(agentSessions)
    .where(
      and(
        eq(
          // jsonb metadata.issueId equality is encoded as a JSONB ->> 'issueId' compare.
          // We avoid heavy SQL fragments here — the session list per device is
          // small enough that filtering in app code is fine.
          agentSessions.id,
          agentSessions.id,
        ),
        inArray(agentSessions.status, ['completed', 'idle']),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt))
    .limit(20);

  for (const r of rows) {
    if (!r.claudeSessionId) continue;
    const meta = r.metadata as { issueId?: string; deviceId?: string } | null;
    if (meta?.issueId !== issueId) continue;
    if (deviceId && meta?.deviceId !== deviceId) continue;
    const usage = r.usage as { contextUsed?: number } | null;
    if ((usage?.contextUsed ?? 0) > MAX_RESUMABLE_CONTEXT) continue;
    return r as never;
  }
  return null;
}

agentSessionRoutes.post(
  '/start',
  zValidator('json', startBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const isReindex = input.type?.endsWith('-reindex') ?? false;
    const isAgentSession = !!input.type;

    if (!input.prompt && !isAgentSession) {
      throw badRequest({ message: 'prompt is required for non-agent sessions' });
    }

    const project = await loadProjectBySlug(input.projectSlug);
    if (!project) throw notFound('project not found');

    const access = await loadProjectAccess(project.id, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    let deviceId: string | null = null;
    if (input.origin !== 'desktop') {
      deviceId = await findAvailableDeviceForProject(project.id);
    }
    if (!deviceId && project.defaultDeviceId) {
      deviceId = project.defaultDeviceId;
    }

    const agentName = input.type ?? 'agent';
    const effectivePrompt =
      input.prompt ?? (isReindex ? `${agentName}: Knowledge Reindex` : `${agentName}: Review`);

    let title: string;
    if (isAgentSession) {
      title = isReindex ? `${agentName} Reindex` : `${agentName} Review`;
    } else if (input.issueIds && input.issueIds.length > 0) {
      const issueRows = await db
        .select({ id: issues.id, issSeq: issues.issSeq, title: issues.title })
        .from(issues)
        .where(inArray(issues.id, input.issueIds));
      if (issueRows.length === 1) {
        title = `ISS-${issueRows[0]?.issSeq} ${issueRows[0]?.title ?? ''}`.slice(0, 120);
      } else if (issueRows.length > 1) {
        title = issueRows.map((i) => `ISS-${i.issSeq}`).join(', ').slice(0, 120);
      } else {
        title = effectivePrompt.slice(0, 120);
      }
    } else {
      title = effectivePrompt
        .replace(/^You are working on issue:\s*/i, '')
        .replace(/^You are working on the following issues:\s*/i, '')
        .replace(/^You are working on:\s*/i, '')
        .slice(0, 120);
    }

    const rp = resolveRepoPath(input.repoPath, project.repoPath);
    const now = Date.now();
    const userMessage = { role: 'user', content: effectivePrompt, timestamp: now };

    // Issue-triggered chats may resume an in-progress Claude CLI session.
    if (
      !isAgentSession &&
      input.issueIds &&
      input.issueIds.length === 1 &&
      input.origin !== 'desktop' &&
      deviceId &&
      input.issueIds[0]
    ) {
      const firstIssueId = input.issueIds[0];
      const resumable = await findResumableSessionForIssue(firstIssueId, deviceId);
      if (resumable) {
        const prevMessages = Array.isArray(resumable.messages) ? resumable.messages : [];
        const messages = [...prevMessages, userMessage];
        const [updated] = await db
          .update(agentSessions)
          .set({ status: 'running', messages, title, updatedAt: new Date() })
          .where(eq(agentSessions.id, resumable.id))
          .returning();
        if (!updated) throw notFound('agent session not found');

        roomManager.publish(deviceRoom(deviceId), {
          event: 'agent:send',
          data: {
            sessionId: updated.id,
            message: effectivePrompt,
            claudeSessionId: resumable.claudeSessionId,
            repoPath: rp,
            projectSlug: input.projectSlug,
          },
        });
        broadcastSession(updated, 'agent-session.updated');
        return c.json(updated);
      }
    }

    const metadata: Record<string, unknown> = isAgentSession ? { type: input.type } : {};
    if (deviceId) metadata.deviceId = deviceId;
    if (input.issueIds?.length === 1 && input.issueIds[0]) {
      metadata.issueId = input.issueIds[0];
    }

    const [inserted] = await db
      .insert(agentSessions)
      .values({
        projectId: project.id,
        userId,
        deviceId,
        title,
        status: 'running',
        repoPath: rp,
        messages: [userMessage] as never,
        metadata: metadata as never,
      })
      .returning();
    if (!inserted) throw new Error('agent_sessions: insert returned no row');

    if (input.origin === 'desktop') {
      // Desktop-originated sessions echo the user message to web subscribers.
      roomManager.publish(projectRoom(project.id), {
        event: 'agent:user-message',
        data: { sessionId: inserted.id, content: effectivePrompt },
      });
    }

    if (input.origin !== 'desktop' && deviceId) {
      if (isAgentSession) {
        const agentEvent = isReindex ? 'agent:reindex' : 'agent:review';
        roomManager.publish(deviceRoom(deviceId), {
          event: agentEvent,
          data: {
            sessionId: inserted.id,
            repoPath: rp,
            projectSlug: input.projectSlug,
          },
        });
      } else {
        let enriched = effectivePrompt;
        if (!input.preBuilt) {
          try {
            const preamble = await buildChatPreamble(project.id);
            enriched = preamble + effectivePrompt;
          } catch {
            // non-fatal — proceed with raw prompt
          }
        }
        roomManager.publish(deviceRoom(deviceId), {
          event: 'agent:start',
          data: {
            sessionId: inserted.id,
            repoPath: rp,
            prompt: enriched,
            projectSlug: input.projectSlug,
            preBuilt: input.preBuilt ?? false,
            systemPrompt: TOOL_REFERENCE,
          },
        });
      }
    }

    broadcastSession(inserted, 'agent-session.created');
    return c.json(inserted, 201);
  },
);

agentSessionRoutes.post(
  '/send',
  zValidator('json', sendBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, input.sessionId))
      .limit(1);
    if (!session) throw notFound('agent session not found');

    const access = await loadProjectAccess(session.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');
    if (session.userId && session.userId !== userId && !isOwnerOrAdmin(access, userId)) {
      throw forbidden('not the session owner');
    }

    const prevMessages = Array.isArray(session.messages) ? session.messages : [];
    const messages = [
      ...prevMessages,
      { role: 'user', content: input.message, timestamp: Date.now() },
    ];
    const [updated] = await db
      .update(agentSessions)
      .set({ messages: messages as never, status: 'running', updatedAt: new Date() })
      .where(eq(agentSessions.id, input.sessionId))
      .returning();
    if (!updated) throw notFound('agent session not found');

    if (input.origin === 'desktop') {
      roomManager.publish(projectRoom(updated.projectId), {
        event: 'agent:user-message',
        data: { sessionId: updated.id, content: input.message },
      });
    }

    if (input.origin !== 'desktop') {
      const meta = (updated.metadata ?? {}) as { deviceId?: string };
      const targetDeviceId = meta.deviceId ?? updated.deviceId ?? null;
      if (targetDeviceId) {
        const [project] = await db
          .select({ slug: projects.slug })
          .from(projects)
          .where(eq(projects.id, updated.projectId))
          .limit(1);
        roomManager.publish(deviceRoom(targetDeviceId), {
          event: 'agent:send',
          data: {
            sessionId: updated.id,
            message: input.message,
            claudeSessionId: input.claudeSessionId ?? updated.claudeSessionId ?? null,
            repoPath: updated.repoPath ?? null,
            projectSlug: project?.slug ?? null,
          },
        });
      }
    }

    broadcastSession(updated, 'agent-session.updated');
    return c.json({ ok: true });
  },
);

agentSessionRoutes.post(
  '/abort',
  zValidator('json', abortBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, input.sessionId))
      .limit(1);
    if (!session) throw notFound('agent session not found');

    const access = await loadProjectAccess(session.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');
    if (session.userId && session.userId !== userId && !isOwnerOrAdmin(access, userId)) {
      throw forbidden('not the session owner');
    }

    const [updated] = await db
      .update(agentSessions)
      .set({ status: 'idle', updatedAt: new Date() })
      .where(eq(agentSessions.id, input.sessionId))
      .returning();
    if (!updated) throw notFound('agent session not found');

    // Strapi parity also pinned `issues.manualHold = true` here for pipeline
    // sessions so the sweeper wouldn't auto-retry. Core's issues schema does
    // not have that field; the heartbeat sweeper isn't ported either, so the
    // "abort = idle" status is enough today. Re-add when manualHold lands.
    const meta = (updated.metadata ?? {}) as {
      type?: string;
      issueId?: string;
      deviceId?: string;
    };

    const targetDeviceId = meta.deviceId ?? updated.deviceId ?? null;
    if (targetDeviceId) {
      roomManager.publish(deviceRoom(targetDeviceId), {
        event: 'agent:abort',
        data: { sessionId: updated.id },
      });
    }

    broadcastSession(updated, 'agent-session.status');
    return c.json({ ok: true });
  },
);

agentSessionRoutes.post(
  '/build-prompt',
  zValidator('json', buildPromptBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const project = await loadProjectBySlug(input.projectSlug);
    if (!project) throw notFound('project not found');

    const access = await loadProjectAccess(project.id, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const deviceId =
      (await findAvailableDeviceForProject(project.id)) ?? project.defaultDeviceId;
    if (!deviceId) {
      throw new HTTPException(503, {
        message: 'no online device for this project',
        cause: { code: 'NO_DEVICE' },
      });
    }

    const requestId = randomUUID();
    roomManager.publish(deviceRoom(deviceId), {
      event: 'agent:build-prompt',
      data: { requestId, projectSlug: input.projectSlug, issueIds: input.issueIds },
    });

    return c.json({ requestId });
  },
);

// Device → core relay for the build-prompt callback. Devices POST here once
// they've assembled the prompt; core fans the result out to whichever web
// client is waiting on `requestId`.
agentSessionRoutes.post(
  '/prompt-built',
  zValidator('json', promptBuiltBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    // Broadcast org-wide on a stable room name. Web clients keyed on
    // requestId filter the relevant message.
    roomManager.publish('agent:prompt-built', {
      event: 'agent:prompt-built',
      data: {
        requestId: input.requestId,
        prompt: input.prompt ?? null,
        error: input.error ?? null,
      },
    });
    return c.json({ ok: true });
  },
);

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

// Web → core probe: "is any desktop device for this project currently online?"
// The agent page polls this on mount + on WS reconnect to decide whether to
// show the "Desktop offline" pill. Returns the Strapi-era envelope shape
// `{ data: { connected } }` for FE-compat. Inputs: `?deviceId` for an
// explicit check, or `?projectSlug` to scan the project's pool + default.
const desktopStatusQuerySchema = z
  .object({
    deviceId: z.uuid().optional(),
    projectSlug: z.string().min(1).max(120).optional(),
  })
  .refine((o) => o.deviceId || o.projectSlug, {
    message: 'deviceId or projectSlug is required',
  });

agentSessionRoutes.get(
  '/desktop/status',
  zValidator('query', desktopStatusQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { deviceId, projectSlug } = c.req.valid('query');

    if (deviceId) {
      const [row] = await db
        .select({ status: devices.status })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      return c.json({ data: { connected: row?.status === 'online' } });
    }

    if (!projectSlug) {
      return c.json({ data: { connected: false } });
    }

    const project = await loadProjectBySlug(projectSlug);
    if (!project) return c.json({ data: { connected: false } });

    const available = await findAvailableDeviceForProject(project.id);
    return c.json({ data: { connected: available !== null } });
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
