import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  agentSessionStatuses,
  agentSessionTurns,
  agentSessions,
  devices,
  issues,
  projectMembers,
  projects,
  users,
} from '../db/schema.js';
import {
  broadcastSession,
  broadcastTurnAppended,
  broadcastTurnEdited,
  broadcastTurnTruncated,
} from './broadcast.js';
import {
  findTurnInSession,
  loadTurns,
  replaceMessageAt,
  sliceMessagesThrough,
  syncTurnsWithMessages,
  truncateTurnsAfter,
} from './turns-helpers.js';
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
    // Optional jsonb filter on `metadata.type` (e.g. ?metadataType=pipeline).
    // Used by /pipeline page to restrict the cross-project list to
    // pipeline-control sessions.
    metadataType: z.string().min(1).max(100).optional(),
    // Optional jsonb filter on `metadata.issueId` — used by the issue detail
    // "Agent Sessions" tab to scope the list to a single issue.
    issueId: z.uuid().optional(),
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

/**
 * Extract a non-empty string prompt from a `messages[i].content` value. The
 * legacy schema lets `content` be either a string or an array of structured
 * blocks (Anthropic-style `[{ type: 'text', text: '…' }, …]`). Returns the
 * trimmed string, or empty string if nothing dispatchable can be recovered.
 */
function extractPromptString(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block === 'object') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
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

// `broadcastSession` is imported from `./broadcast.ts` so per-turn handlers can
// share the same fan-out shape (project room + owning device room).

export const agentSessionRoutes = new Hono<{ Variables: AuthVars }>();
agentSessionRoutes.use('*', requireAuth(), assertEmailVerified());

// === Static-path lifecycle routes (start / send / abort / build-prompt /
// prompt-built). All mounted BEFORE the `:id` handlers to avoid uuid validator
// collisions. The web UI calls these to drive an interactive Claude CLI
// conversation through the device-runner — the device speaks the legacy
// `agent:start | agent:send | agent:abort | agent:review | agent:reindex`
// vocabulary on its WS channel (packages/dev preserves these handlers from
// Strapi parity), so core just resolves a device, persists the session row,
// and publishes the right event into the device's room.

// Bubble panel auto-injects which page (and which issue) the user is on so
// the agent can ground its replies without the user typing "ISS-XX" by hand.
const pageContextSchema = z
  .object({
    page: z.string().min(1).max(40),
    issueId: z.uuid().optional(),
    issueDisplayId: z.string().max(40).optional(),
    issueTitle: z.string().max(500).optional(),
    issueStatus: z.string().max(40).optional(),
  })
  .strict();

type PageContext = z.infer<typeof pageContextSchema>;

function formatPageContextLine(ctx: PageContext): string {
  const sanitize = (s: string) => s.replace(/[\r\n\]]/g, ' ').replace(/'/g, '');
  const parts: string[] = [`page=${sanitize(ctx.page)}`];
  if (ctx.issueDisplayId) parts.push(sanitize(ctx.issueDisplayId));
  if (ctx.issueTitle) parts.push(`'${sanitize(ctx.issueTitle)}'`);
  if (ctx.issueStatus) parts.push(`status=${sanitize(ctx.issueStatus)}`);
  return `[Context: ${parts.join(' ')}]`;
}

// Re-validate persisted pageContext on read — corrupt jsonb rows could feed
// garbage into samePageContext / formatPageContextLine. safeParse failure is
// treated as "no prior context" so the next turn re-prepends the header.
function readPersistedPageContext(value: unknown): PageContext | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = pageContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function samePageContext(a: PageContext | null | undefined, b: PageContext): boolean {
  if (!a) return false;
  if (a.page !== b.page) return false;
  // If both sides have an issueId, they must match. When one side is missing
  // (the issue query hadn't resolved yet on the previous turn, or this turn),
  // treat the same page as a match — otherwise we'd echo the [Context: …] line
  // every time the issue data races into place.
  if (a.issueId && b.issueId) return a.issueId === b.issueId;
  return true;
}

const startBodySchema = z
  .object({
    projectSlug: z.string().min(1).max(120),
    prompt: z.string().min(1).max(40_000).optional(),
    repoPath: z.string().max(2000).nullable().optional(),
    preBuilt: z.boolean().optional(),
    issueIds: z.array(z.uuid()).max(50).optional(),
    type: z.string().max(80).optional(),
    origin: z.string().max(40).optional(),
    pageContext: pageContextSchema.optional(),
  })
  .strict();

const sendBodySchema = z
  .object({
    sessionId: z.uuid(),
    message: z.string().min(1).max(40_000),
    claudeSessionId: z.string().max(500).nullable().optional(),
    origin: z.string().max(40).optional(),
    pageContext: pageContextSchema.optional(),
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
  startedAt: Date | null;
} | null> {
  const rows = await db
    .select({
      id: agentSessions.id,
      claudeSessionId: agentSessions.claudeSessionId,
      messages: agentSessions.messages,
      metadata: agentSessions.metadata,
      usage: agentSessions.usage,
      status: agentSessions.status,
      startedAt: agentSessions.startedAt,
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
    const rawPrompt =
      input.prompt ?? (isReindex ? `${agentName}: Knowledge Reindex` : `${agentName}: Review`);
    const effectivePrompt =
      input.pageContext && !isAgentSession
        ? `${formatPageContextLine(input.pageContext)}\n${rawPrompt}`
        : rawPrompt;

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
        title = rawPrompt.slice(0, 120);
      }
    } else {
      title = rawPrompt
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
        // Resumable replays through /start but persists like /send: re-prepend
        // the [Context: …] header only when page or issue changed since the
        // previous turn so a long-lived chat doesn't echo it every reply.
        const prevMeta = (resumable.metadata ?? {}) as Record<string, unknown> & {
          pageContext?: unknown;
        };
        const lastPageContext = readPersistedPageContext(prevMeta.pageContext);
        const shouldPrepend =
          input.pageContext && !samePageContext(lastPageContext, input.pageContext);
        const resumablePrompt = shouldPrepend
          ? `${formatPageContextLine(input.pageContext as PageContext)}\n${rawPrompt}`
          : rawPrompt;
        const resumableUserMessage = { role: 'user', content: resumablePrompt, timestamp: now };
        const prevMessages = Array.isArray(resumable.messages) ? resumable.messages : [];
        const messages = [...prevMessages, resumableUserMessage];
        const nowDate = new Date();
        const resumableUpdates: Record<string, unknown> = {
          status: 'running',
          messages,
          title,
          startedAt: resumable.startedAt ?? nowDate,
          lastHeartbeatAt: nowDate,
          failureReason: null,
          updatedAt: nowDate,
        };
        if (input.pageContext) {
          resumableUpdates.metadata = { ...prevMeta, pageContext: input.pageContext };
        }
        const { updated, resumeSync } = await db.transaction(async (tx) => {
          const [row] = await tx
            .update(agentSessions)
            .set(resumableUpdates)
            .where(eq(agentSessions.id, resumable.id))
            .returning();
          if (!row) throw notFound('agent session not found');
          // Materialize the appended user turn in the same transaction so the
          // legacy blob and turn rows can never diverge if the insert throws.
          const sync = await syncTurnsWithMessages(row.id, prevMessages, messages, tx);
          return { updated: row, resumeSync: sync };
        });
        for (const t of resumeSync.appended) {
          broadcastTurnAppended(updated, t);
        }

        roomManager.publish(deviceRoom(deviceId), {
          event: 'agent:send',
          data: {
            sessionId: updated.id,
            message: resumablePrompt,
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
    // Agent (review/reindex) sessions skip the prepended [Context: …] line, so
    // don't persist pageContext on metadata either — otherwise a follow-up
    // /send would see a non-null lastPageContext and dedup against context the
    // agent never actually saw.
    if (input.pageContext && !isAgentSession) {
      metadata.pageContext = input.pageContext;
    }

    // Interactive sessions start `running` (worker streams within seconds);
    // stamp startedAt + heartbeat for parity with the pipeline path.
    const nowDate = new Date();
    const { inserted, startSync } = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(agentSessions)
        .values({
          projectId: project.id,
          userId,
          deviceId,
          title,
          status: 'running',
          startedAt: nowDate,
          lastHeartbeatAt: nowDate,
          repoPath: rp,
          messages: [userMessage] as never,
          metadata: metadata as never,
        })
        .returning();
      if (!row) throw new Error('agent_sessions: insert returned no row');
      // Seed the per-turn table inside the same transaction so a failed turn
      // insert rolls back the session row instead of leaving an orphan.
      const sync = await syncTurnsWithMessages(row.id, [], [userMessage], tx);
      return { inserted: row, startSync: sync };
    });
    for (const t of startSync.appended) {
      broadcastTurnAppended(inserted, t);
    }

    {
      const auditIssueId = extractIssueId(inserted.metadata);
      if (auditIssueId) {
        await safeRecordActivity({
          issueId: auditIssueId,
          actor: { type: 'user', id: userId },
          action: 'agent-session.created',
          payload: { sessionId: inserted.id, title: inserted.title ?? null },
        });
      }
    }

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

    const prevMeta = (session.metadata ?? {}) as Record<string, unknown> & {
      pageContext?: unknown;
    };
    const lastPageContext = readPersistedPageContext(prevMeta.pageContext);
    // Re-prepend the [Context: …] line only when the user has switched page or
    // issue since the previous turn — otherwise every send would echo the same
    // header to the agent.
    const shouldPrepend =
      input.pageContext && !samePageContext(lastPageContext, input.pageContext);
    const decoratedMessage = shouldPrepend
      ? `${formatPageContextLine(input.pageContext as PageContext)}\n${input.message}`
      : input.message;

    const prevMessages = Array.isArray(session.messages) ? session.messages : [];
    const messages = [
      ...prevMessages,
      { role: 'user', content: decoratedMessage, timestamp: Date.now() },
    ];
    // Worker activity → CAS queued→running and bump heartbeat for the sweeper.
    const sendNow = new Date();
    const sendUpdates: Record<string, unknown> = {
      messages: messages as never,
      status: 'running',
      lastHeartbeatAt: sendNow,
      updatedAt: sendNow,
    };
    if (input.pageContext) {
      sendUpdates.metadata = { ...prevMeta, pageContext: input.pageContext };
    }
    if (session.status === 'queued' || session.startedAt == null) {
      sendUpdates.startedAt = sendNow;
    }
    const { updated, sendSync } = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(agentSessions)
        .set(sendUpdates)
        .where(eq(agentSessions.id, input.sessionId))
        .returning();
      if (!row) throw notFound('agent session not found');
      const sync = await syncTurnsWithMessages(row.id, prevMessages, messages, tx);
      return { updated: row, sendSync: sync };
    });
    for (const t of sendSync.appended) {
      broadcastTurnAppended(updated, t);
    }

    if (input.origin === 'desktop') {
      roomManager.publish(projectRoom(updated.projectId), {
        event: 'agent:user-message',
        data: { sessionId: updated.id, content: decoratedMessage },
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
            message: decoratedMessage,
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

// Pipeline-session types for the retry endpoint. Mirrors the predicate
// used by sweeper.ts and the migration backfill.
const PIPELINE_SESSION_TYPES = new Set<string>(['pipeline', 'pm']);

// /cancel marks terminal as `failed` with reason='user_cancelled' (vs
// /abort which sets 'idle' so the user can resume). The sweeper then
// routes the linked job through recovery or escalation.
agentSessionRoutes.post(
  '/:id/cancel',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!session) throw notFound('agent session not found');

    const access = await loadProjectAccess(session.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');
    if (session.userId && session.userId !== userId && !isOwnerOrAdmin(access, userId)) {
      throw forbidden('not the session owner');
    }

    if (session.status === 'completed' || session.status === 'failed') {
      // Already terminal — return current state, idempotent.
      return c.json(session);
    }

    const cancelNow = new Date();
    // CAS on the active statuses we observed: a worker write that lands
    // between the SELECT and this UPDATE will not be in queued/running
    // anymore, and we'd silently no-op rather than stomp it.
    const [updated] = await db
      .update(agentSessions)
      .set({
        status: 'failed',
        failureReason: 'user_cancelled',
        updatedAt: cancelNow,
      })
      .where(
        and(
          eq(agentSessions.id, id),
          inArray(agentSessions.status, ['queued', 'running', 'idle']),
        ),
      )
      .returning();
    if (!updated) {
      // CAS lost — return the current row so the client can re-render.
      const [current] = await db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, id))
        .limit(1);
      if (!current) throw notFound('agent session not found');
      return c.json(current);
    }

    const meta = (updated.metadata ?? {}) as { deviceId?: string };
    const targetDeviceId = meta.deviceId ?? updated.deviceId ?? null;
    if (targetDeviceId) {
      roomManager.publish(deviceRoom(targetDeviceId), {
        event: 'agent:abort',
        data: { sessionId: updated.id, reason: 'user_cancelled' },
      });
    }

    broadcastSession(updated, 'agent-session.status', { failureReason: 'user_cancelled' });
    return c.json(updated);
  },
);

// Idempotency on /retry comes from orchestrator.reEnqueueForIssue + the
// unique-active-job index — re-firing while a job is queued/running is a
// no-op.
agentSessionRoutes.post(
  '/:id/retry',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!session) throw notFound('agent session not found');

    const access = await loadProjectAccess(session.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const meta = (session.metadata ?? {}) as { type?: string; issueId?: string };
    if (!meta.type || !PIPELINE_SESSION_TYPES.has(meta.type)) {
      throw new HTTPException(400, {
        message: 'retry only supported for pipeline sessions',
        cause: { code: 'NOT_PIPELINE_SESSION' },
      });
    }
    if (!meta.issueId) {
      throw new HTTPException(400, {
        message: 'session has no linked issue',
        cause: { code: 'NO_ISSUE_LINK' },
      });
    }

    const [issue] = await db
      .select({ id: issues.id, status: issues.status, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, meta.issueId))
      .limit(1);
    if (!issue) {
      throw new HTTPException(404, {
        message: 'linked issue not found',
        cause: { code: 'ISSUE_NOT_FOUND' },
      });
    }

    // Lazy-import breaks the agent-sessions ↔ pipeline import cycle.
    const { reEnqueueForIssue } = await import('../pipeline/orchestrator.js');
    await reEnqueueForIssue({
      projectId: issue.projectId,
      issueId: issue.id,
      status: issue.status,
      actor: { type: 'user', id: userId },
      reason: { manualRetry: { sessionId: id, prevFailureReason: session.failureReason } },
    });

    return c.json({ ok: true, issueId: issue.id });
  },
);

// Queue depth per device — backs the worker panel + session placeholder.
const queueStatsQuerySchema = z
  .object({
    projectId: z.uuid(),
  })
  .strict();

agentSessionRoutes.get(
  '/queue-stats',
  zValidator('query', queueStatsQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    // Group counts by deviceId × status. Devices without any active session
    // simply don't appear; the UI lists those via the standard devices API.
    const rows = await db
      .select({
        deviceId: agentSessions.deviceId,
        status: agentSessions.status,
        count: count(),
      })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.projectId, projectId),
          inArray(agentSessions.status, ['queued', 'running']),
        ),
      )
      .groupBy(agentSessions.deviceId, agentSessions.status);

    type Bucket = { deviceId: string | null; queued: number; running: number };
    const buckets = new Map<string, Bucket>();
    for (const r of rows) {
      const key = r.deviceId ?? '__null__';
      const b = buckets.get(key) ?? { deviceId: r.deviceId, queued: 0, running: 0 };
      if (r.status === 'queued') b.queued = Number(r.count);
      if (r.status === 'running') b.running = Number(r.count);
      buckets.set(key, b);
    }
    return c.json({ devices: Array.from(buckets.values()) });
  },
);

// Manual sweep trigger — flush zombies without waiting for the cron tick.
const sweepQuerySchema = z
  .object({
    projectId: z.uuid(),
  })
  .strict();

agentSessionRoutes.post(
  '/sweep-zombies',
  zValidator('query', sweepQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!isOwnerOrAdmin(access, userId)) throw forbidden('owner or admin role required');

    const { sweepZombieSessions } = await import('../pipeline/sweeper.js');
    const result = await sweepZombieSessions(new Date(), { projectId });
    return c.json(result);
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
    const { projectId, deviceId, status, metadataType, issueId, page, pageSize } =
      c.req.valid('query');
    const userId = c.get('userId');

    const conditions: SQL[] = [];

    if (projectId) {
      const access = await loadProjectAccess(projectId, userId);
      if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');
      conditions.push(eq(agentSessions.projectId, projectId));
    } else if (deviceId) {
      conditions.push(eq(agentSessions.deviceId, deviceId));
    } else {
      // Cross-project view: restrict to caller-visible projects.
      // CEO sees all; everyone else sees owned + member projects.
      // Pattern mirrors packages/core/src/chat-logs/routes.ts + projects/health-routes.ts.
      const [me] = await db
        .select({ id: users.id, isCeo: users.isCeo })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      const visible = me?.isCeo
        ? await db.select({ id: projects.id }).from(projects)
        : await db
            .selectDistinct({ id: projects.id })
            .from(projects)
            .leftJoin(projectMembers, eq(projectMembers.projectId, projects.id))
            .where(sql`${projects.ownerId} = ${userId} OR ${projectMembers.userId} = ${userId}`);

      if (visible.length === 0) {
        setTotalCount(c, 0);
        return c.json([]);
      }

      conditions.push(
        inArray(
          agentSessions.projectId,
          visible.map((v) => v.id),
        ),
      );
    }

    if (status) conditions.push(eq(agentSessions.status, status));
    if (metadataType) {
      conditions.push(sql`${agentSessions.metadata}->>'type' = ${metadataType}`);
    }
    if (issueId) {
      conditions.push(sql`${agentSessions.metadata}->>'issueId' = ${issueId}`);
    }

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

    {
      const auditIssueId = extractIssueId(inserted.metadata);
      if (auditIssueId) {
        await safeRecordActivity({
          issueId: auditIssueId,
          actor: { type: 'user', id: userId },
          action: 'agent-session.created',
          payload: { sessionId: inserted.id, title: inserted.title ?? null },
        });
      }
    }

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

    const patchNow = new Date();
    const updates: Record<string, unknown> = { updatedAt: patchNow };
    if (patch.title !== undefined) updates.title = patch.title;
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.claudeSessionId !== undefined) updates.claudeSessionId = patch.claudeSessionId;
    if (patch.repoPath !== undefined) updates.repoPath = patch.repoPath;
    if (patch.messages !== undefined) updates.messages = patch.messages;
    if (patch.usage !== undefined) updates.usage = patch.usage;
    if (patch.metadata !== undefined) updates.metadata = patch.metadata;
    if (patch.diff !== undefined) updates.diff = patch.diff;

    // Any worker-side write is a heartbeat signal; CAS queued→running on
    // first activity so the sweeper sees a fresh stamp.
    const isWorkerActivity =
      patch.messages !== undefined ||
      patch.claudeSessionId !== undefined ||
      patch.usage !== undefined ||
      patch.status !== undefined ||
      patch.diff !== undefined;
    // A user_cancelled session must never silently revive — once cancelled,
    // a worker stream that arrives late should be dropped, not re-attached.
    const isUserCancelled =
      existing.status === 'failed' && existing.failureReason === 'user_cancelled';
    if (isUserCancelled && (patch.status === 'running' || patch.status === 'queued')) {
      throw new HTTPException(409, {
        message: 'session was cancelled by user',
        cause: { code: 'SESSION_CANCELLED' },
      });
    }
    if (isWorkerActivity && !isUserCancelled) {
      updates.lastHeartbeatAt = patchNow;
    }
    if (
      patch.status === undefined &&
      isWorkerActivity &&
      existing.status === 'queued'
    ) {
      updates.status = 'running';
      updates.startedAt = patchNow;
    } else if (patch.status === 'running' && existing.startedAt == null) {
      updates.startedAt = patchNow;
    }
    // Revival clears stale reason — but never overrides user_cancelled (guarded above).
    if (
      (updates.status === 'running' || updates.status === 'queued') &&
      existing.failureReason &&
      existing.failureReason !== 'user_cancelled'
    ) {
      updates.failureReason = null;
    }

    // Dual-write: when the worker PATCHes the messages array we mirror append /
    // truncate into agent_session_turns inside the same transaction so the
    // legacy blob and turn rows can never diverge. Streaming-tail debounce is
    // handled by broadcastTurnAppended so we don't spam clients while the
    // runner streams.
    // Only open a transaction when the messages array is being mirrored into
    // agent_session_turns — otherwise high-frequency status/heartbeat PATCHes
    // from the runner pay an unnecessary tx round-trip.
    const messagesPatched = patch.messages !== undefined;
    let updated;
    let sync: Awaited<ReturnType<typeof syncTurnsWithMessages>> | null = null;
    if (messagesPatched) {
      const txResult = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(agentSessions)
          .set(updates)
          .where(eq(agentSessions.id, id))
          .returning();
        if (!row) throw notFound('agent session not found');
        const prevMessages = Array.isArray(existing.messages) ? existing.messages : [];
        const nextMessages = Array.isArray(patch.messages) ? patch.messages : [];
        const result = await syncTurnsWithMessages(row.id, prevMessages, nextMessages, tx);
        return { updated: row, sync: result };
      });
      updated = txResult.updated;
      sync = txResult.sync;
    } else {
      const [row] = await db
        .update(agentSessions)
        .set(updates)
        .where(eq(agentSessions.id, id))
        .returning();
      if (!row) throw notFound('agent session not found');
      updated = row;
    }

    if (sync) {
      // First new turn fires immediately so the client learns the turn id.
      // Subsequent appends (multi-block worker write) ride the tail-debouncer
      // in broadcastTurnAppended to keep WS load manageable while the runner
      // streams a long assistant reply.
      sync.appended.forEach((t, i) => {
        broadcastTurnAppended(updated, t, { isStreamingTail: i > 0 });
      });
      if (sync.truncatedFromTurnIndex !== null) {
        broadcastTurnTruncated(updated, sync.truncatedFromTurnIndex);
      }
    }

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

const turnIdParamSchema = z.object({
  id: z.uuid(),
  turnId: z.uuid(),
});

const turnsQuerySchema = z.object({
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const editTurnBodySchema = z
  .object({
    content: z.string().min(1).max(40_000),
    expectedEditedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

const forkBodySchema = z
  .object({
    fromTurnId: z.uuid(),
    title: z.string().min(1).max(500).optional(),
  })
  .strict();

async function ensureSessionMember(sessionId: string, userId: string) {
  const [session] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!session) throw notFound('agent session not found');
  const access = await loadProjectAccess(session.projectId, userId);
  if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');
  return { session, access };
}

agentSessionRoutes.get(
  '/:id/turns',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', turnsQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { after, limit } = c.req.valid('query');
    const userId = c.get('userId');
    await ensureSessionMember(id, userId);

    const opts: { afterTurnIndex?: number; limit?: number } = {};
    if (after) {
      const cursor = await findTurnInSession(id, after);
      if (!cursor) throw notFound('cursor turn not found');
      opts.afterTurnIndex = cursor.turnIndex;
    }
    if (limit !== undefined) opts.limit = limit;

    const result = await loadTurns(id, opts);
    return c.json(result);
  },
);

agentSessionRoutes.patch(
  '/:id/turns/:turnId',
  zValidator('param', turnIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', editTurnBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id, turnId } = c.req.valid('param');
    const { content, expectedEditedAt } = c.req.valid('json');
    const userId = c.get('userId');

    const { session } = await ensureSessionMember(id, userId);
    if (session.userId && session.userId !== userId) {
      const access = await loadProjectAccess(session.projectId, userId);
      if (!isOwnerOrAdmin(access, userId)) throw forbidden('not the session owner');
    }

    const turn = await findTurnInSession(id, turnId);
    if (!turn) throw notFound('turn not found');
    if (turn.role !== 'user') {
      throw new HTTPException(400, {
        message: 'only user turns can be edited',
        cause: { code: 'TURN_NOT_USER' },
      });
    }
    // Last-write-wins precondition: if the caller asserts it saw a specific
    // edited_at, reject when the row has changed since (ISO compare avoids
    // tz drift between Postgres and JS).
    if (expectedEditedAt !== undefined && expectedEditedAt !== null) {
      const current = turn.editedAt ? turn.editedAt.toISOString() : null;
      if (current !== expectedEditedAt) {
        throw new HTTPException(409, {
          message: 'turn was edited by someone else',
          cause: { code: 'TURN_STALE' },
        });
      }
    }

    const editNow = new Date();
    // Preserve the original entry's auxiliary fields (timestamp, attachments,
    // tool calls, …) while replacing the user-visible content. The row stores
    // the wrapped shape `{ value: <messageEntry> }`, so unwrap one level before
    // re-wrapping — otherwise we'd nest a second `value` and corrupt the row.
    const origValue = (turn.content as { value?: unknown }).value;
    const origObj =
      origValue && typeof origValue === 'object' ? (origValue as Record<string, unknown>) : {};
    const newContent = { value: { ...origObj, role: turn.role, content } };

    const [updatedTurn, updatedSession] = await db.transaction(async (tx) => {
      const [turnRow] = await tx
        .update(agentSessionTurns)
        .set({ content: newContent as never, editedAt: editNow })
        .where(eq(agentSessionTurns.id, turnId))
        .returning();
      if (!turnRow) throw notFound('turn not found');

      // Mirror into the legacy jsonb blob so resumable-session reads stay
      // consistent until the deprecation lands.
      const newMessages = replaceMessageAt(session.messages, turn.turnIndex, (entry) => {
        if (!entry || typeof entry !== 'object') return { content };
        return { ...(entry as Record<string, unknown>), content };
      });
      const [sessionRow] = await tx
        .update(agentSessions)
        .set({ messages: newMessages as never, updatedAt: editNow })
        .where(eq(agentSessions.id, id))
        .returning();
      if (!sessionRow) throw notFound('agent session not found');
      return [turnRow, sessionRow] as const;
    });

    broadcastTurnEdited(updatedSession, turnId);
    return c.json(updatedTurn);
  },
);

agentSessionRoutes.post(
  '/:id/turns/:turnId/regenerate',
  zValidator('param', turnIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id, turnId } = c.req.valid('param');
    const userId = c.get('userId');

    const { session } = await ensureSessionMember(id, userId);
    if (session.userId && session.userId !== userId) {
      const access = await loadProjectAccess(session.projectId, userId);
      if (!isOwnerOrAdmin(access, userId)) throw forbidden('not the session owner');
    }

    if (session.status === 'running') {
      throw new HTTPException(409, {
        message: 'abort the in-flight turn before regenerating',
        cause: { code: 'SESSION_RUNNING' },
      });
    }

    const turn = await findTurnInSession(id, turnId);
    if (!turn) throw notFound('turn not found');

    // Truncate everything after the turn (keep the turn itself). For a user
    // turn this means "regenerate replies"; for an assistant turn this means
    // "drop this reply and re-generate from the prior user message".
    const keepThrough = turn.role === 'assistant' ? turn.turnIndex - 1 : turn.turnIndex;
    const messages = sliceMessagesThrough(session.messages, keepThrough);
    const truncatedFromIndex = keepThrough + 1;

    // Resolve the prompt for the worker dispatch up-front so we can fail fast
    // if there's no usable string to send. Otherwise the truncate would commit
    // and the row would sit in `queued` forever with no agent:send fired.
    const lastUserEntry = [...messages].reverse().find((m) => {
      return !!m && typeof m === 'object' && (m as { role?: string }).role === 'user';
    }) as { content?: unknown } | undefined;
    const targetMessage = extractPromptString(lastUserEntry?.content);
    const meta = (session.metadata ?? {}) as { deviceId?: string };
    const targetDeviceId = meta.deviceId ?? session.deviceId ?? null;
    if (targetDeviceId && !targetMessage) {
      throw new HTTPException(409, {
        message: 'no dispatchable prompt found before this turn',
        cause: { code: 'NO_DISPATCHABLE_PROMPT' },
      });
    }

    const regenNow = new Date();
    const updated = await db.transaction(async (tx) => {
      await truncateTurnsAfter(id, keepThrough, tx);
      const [row] = await tx
        .update(agentSessions)
        .set({
          messages: messages as never,
          status: 'queued',
          failureReason: null,
          dispatchedAt: regenNow,
          updatedAt: regenNow,
        })
        .where(eq(agentSessions.id, id))
        .returning();
      if (!row) throw notFound('agent session not found');
      return row;
    });

    // Re-publish to the device with the most recent user turn as the prompt
    // (already validated above; reuse the resolved values).
    if (targetDeviceId && targetMessage) {
      const [project] = await db
        .select({ slug: projects.slug })
        .from(projects)
        .where(eq(projects.id, updated.projectId))
        .limit(1);
      roomManager.publish(deviceRoom(targetDeviceId), {
        event: 'agent:send',
        data: {
          sessionId: updated.id,
          message: targetMessage,
          claudeSessionId: updated.claudeSessionId ?? null,
          repoPath: updated.repoPath ?? null,
          projectSlug: project?.slug ?? null,
        },
      });
    }

    broadcastTurnTruncated(updated, truncatedFromIndex);
    broadcastSession(updated, 'agent-session.status');
    return c.json({ status: updated.status });
  },
);

agentSessionRoutes.post(
  '/:id/fork',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', forkBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { fromTurnId, title } = c.req.valid('json');
    const userId = c.get('userId');

    const { session } = await ensureSessionMember(id, userId);
    const turn = await findTurnInSession(id, fromTurnId);
    if (!turn) throw notFound('turn not found');

    // Eager copy: slice both the jsonb blob and the per-turn rows up through
    // (and including) the fork point. Storage cost is acceptable at our session
    // scale (cap < 40k tokens × N turns); avoiding copy-on-write keeps reads
    // simple and avoids cross-session FK juggling.
    const slicedMessages = sliceMessagesThrough(session.messages, turn.turnIndex);

    const prevMeta = (session.metadata ?? {}) as Record<string, unknown>;
    const newMetadata = {
      ...prevMeta,
      parentSessionId: id,
      forkedFromTurnId: fromTurnId,
    };

    const { inserted, seedSync } = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(agentSessions)
        .values({
          projectId: session.projectId,
          userId: session.userId,
          deviceId: session.deviceId,
          title: title ?? (session.title ? `${session.title} (fork)` : null),
          status: 'idle',
          repoPath: session.repoPath,
          messages: slicedMessages as never,
          metadata: newMetadata as never,
        })
        .returning();
      if (!row) throw new Error('agent_sessions: insert returned no row');
      // Materialize matching turn rows in the new session. We don't reuse the
      // parent ids — fresh ids isolate edits/regenerations per fork.
      const sync = await syncTurnsWithMessages(row.id, [], slicedMessages, tx);
      return { inserted: row, seedSync: sync };
    });
    for (const t of seedSync.appended) {
      broadcastTurnAppended(inserted, t);
    }

    broadcastSession(inserted, 'agent-session.created');

    {
      const auditIssueId = extractIssueId(inserted.metadata);
      if (auditIssueId) {
        await safeRecordActivity({
          issueId: auditIssueId,
          actor: { type: 'user', id: userId },
          action: 'agent-session.created',
          payload: { sessionId: inserted.id, title: inserted.title ?? null },
        });
      }
    }

    return c.json(inserted, 201);
  },
);

agentSessionRoutes.post(
  '/:id/rerun',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const { session } = await ensureSessionMember(id, userId);
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const firstUser = messages.find((m) => {
      return !!m && typeof m === 'object' && (m as { role?: string }).role === 'user';
    }) as { content?: unknown } | undefined;
    const prompt = extractPromptString(firstUser?.content);
    if (!prompt) {
      throw new HTTPException(400, {
        message: 'no user prompt to rerun',
        cause: { code: 'NO_PROMPT' },
      });
    }

    const prevMeta = (session.metadata ?? {}) as Record<string, unknown>;
    const newMetadata = {
      ...prevMeta,
      rerunOfSessionId: id,
    };

    const nowDate = new Date();
    const seedMessage = { role: 'user', content: prompt, timestamp: nowDate.getTime() };
    // Mirror the start-flow status rule: only flip to `running` when a device
    // is bound (a runner will pick it up). Without one, leave the session
    // `queued` until a device claims it — otherwise the row is `running` with
    // no worker attached and stays stuck forever.
    const hasDevice = !!session.deviceId;
    const { inserted, seedSync } = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(agentSessions)
        .values({
          projectId: session.projectId,
          userId: session.userId ?? userId,
          deviceId: session.deviceId,
          title: session.title ? `${session.title} (rerun)` : null,
          status: hasDevice ? 'running' : 'queued',
          startedAt: hasDevice ? nowDate : null,
          lastHeartbeatAt: hasDevice ? nowDate : null,
          repoPath: session.repoPath,
          messages: [seedMessage] as never,
          metadata: newMetadata as never,
        })
        .returning();
      if (!row) throw new Error('agent_sessions: insert returned no row');
      const sync = await syncTurnsWithMessages(row.id, [], [seedMessage], tx);
      return { inserted: row, seedSync: sync };
    });
    for (const t of seedSync.appended) {
      broadcastTurnAppended(inserted, t);
    }

    const targetDeviceId = inserted.deviceId;
    if (targetDeviceId) {
      const [project] = await db
        .select({ slug: projects.slug })
        .from(projects)
        .where(eq(projects.id, inserted.projectId))
        .limit(1);
      roomManager.publish(deviceRoom(targetDeviceId), {
        event: 'agent:start',
        data: {
          sessionId: inserted.id,
          repoPath: inserted.repoPath ?? null,
          prompt,
          projectSlug: project?.slug ?? null,
          preBuilt: false,
        },
      });
    }

    broadcastSession(inserted, 'agent-session.created');

    {
      const auditIssueId = extractIssueId(inserted.metadata);
      if (auditIssueId) {
        await safeRecordActivity({
          issueId: auditIssueId,
          actor: { type: 'user', id: userId },
          action: 'agent-session.created',
          payload: { sessionId: inserted.id, title: inserted.title ?? null },
        });
      }
    }

    return c.json(inserted, 201);
  },
);
