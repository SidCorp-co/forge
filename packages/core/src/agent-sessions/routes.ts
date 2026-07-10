import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { type SQL, and, count, desc, eq, inArray, sql } from 'drizzle-orm';
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
  projects,
  runners,
  schedules,
  usageRecords,
} from '../db/schema.js';
import { resolveProjectDefaultMcpServers } from '../jobs/stage-overrides.js';
import {
  assertProjectRole,
  loadProjectAccess,
  loadVisibleProjectIds,
  projectRoleAtLeast,
} from '../lib/authz.js';
import {
  findAvailableDeviceForProject,
  resolveRepoPath,
  resolveRunnerRepoPath,
} from '../lib/device-pool.js';
import { setTotalCount } from '../lib/pagination.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireUserOrDevice } from '../middleware/auth.js';
import { safeRecordActivity } from '../pipeline/activity.js';
import { closeRunIfOneShot, openOneShotRun } from '../pipeline/runs.js';
import { extractReportFromMessages } from '../schedules/messages/skill-improve-prompt.js';
import { extractStewardReportFromMessages } from '../schedules/messages/skill-steward-prompt.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import {
  broadcastSession,
  broadcastTurnAppended,
  broadcastTurnEdited,
  broadcastTurnTruncated,
} from './broadcast.js';
import {
  createChatSessionRow,
  dispatchChatTurn,
  noClaudeClient,
  resolveChatDevice,
} from './chat-turn.js';
import { pageContextSchema } from './page-context.js';
import {
  DEFAULT_PIPELINE_HEALTH,
  type PipelineControl,
  type PipelineHealth,
  buildPipelineControl,
  buildPipelineHealth,
  normalisePipelineControl,
  pipelineControlInputSchema,
  pipelineHealthInputSchema,
} from './pipeline-control-types.js';
import {
  findTurnInSession,
  loadTurns,
  replaceMessageAt,
  sliceMessagesThrough,
  syncTurnsWithMessages,
  truncateTurnsAfter,
} from './turns-helpers.js';

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
    // ISS-465 archive filter. Default excludes metadata.archived='true' so
    // archived chats drop out of the active history without affecting
    // pipeline/pm rows (whose metadata has no `archived` key — IS DISTINCT
    // FROM keeps them). Pass ?archived=true to read the archived set.
    archived: z.enum(['true', 'false']).optional(),
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

/**
 * ISS-572 — build a failure-text blob from a session's transcript + the
 * runner's terminal `note`, so a usage/session-limit RESULT_ERROR that the
 * runner streamed into the messages (e.g. `[RESULT_ERROR] success: You've hit
 * your weekly limit · resets 11am (Asia/Ho_Chi_Minh)`) can be classified.
 * Scans only the tail (limits surface in the terminal system/assistant
 * message) and caps length so a long transcript stays cheap.
 */
function extractSessionFailureText(messages: unknown, note: string | null | undefined): string {
  const parts: string[] = [];
  if (typeof note === 'string' && note.trim()) parts.push(note);
  if (Array.isArray(messages)) {
    for (const m of messages.slice(-6)) {
      if (m && typeof m === 'object') {
        const content = (m as { content?: unknown }).content;
        const text = extractPromptString(content);
        if (text) parts.push(text);
      }
    }
  }
  const blob = parts.join('\n');
  return blob.length > 4000 ? blob.slice(-4000) : blob;
}

// `broadcastSession` is imported from `./broadcast.ts` so per-turn handlers can
// share the same fan-out shape (project room + owning device room).

export const agentSessionRoutes = new Hono<{ Variables: AuthVars }>();
// Dual-auth: user JWT (web/desktop) OR device token (a CLI runner streaming a
// chat reply back via PATCH /:id). Non-device routes still authorize via
// `loadProjectAccess(_, userId)`, which fails closed for a device principal.
agentSessionRoutes.use('*', requireUserOrDevice(), assertEmailVerified());

// === Static-path lifecycle routes (start / send / abort / build-prompt /
// prompt-built). All mounted BEFORE the `:id` handlers to avoid uuid validator
// collisions. The web UI calls these to drive an interactive Claude CLI
// conversation through the device-runner — the device speaks the legacy
// `agent:start | agent:send | agent:abort | agent:review | agent:reindex`
// vocabulary on its WS channel (packages/dev preserves these handlers from
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
    pageContext: pageContextSchema.optional(),
    // ISS-499 — session attachments to attach to the first turn.
    attachmentIds: z.array(z.uuid()).max(10).optional(),
  })
  .strict();

const sendBodySchema = z
  .object({
    sessionId: z.uuid(),
    // ISS-499 — empty allowed when attachmentIds are present (files-only send,
    // e.g. attach a screenshot with no caption); the refine below enforces that
    // a turn carries either text or at least one attachment.
    message: z.string().max(40_000),
    claudeSessionId: z.string().max(500).nullable().optional(),
    // Explicit runner pick from the chat runner picker: dispatch THIS turn (and
    // re-pin the session) to this device instead of reusing the pin / auto-
    // picking. Validated in `resolveChatDevice` against the chat-capable gate.
    deviceId: z.uuid().nullable().optional(),
    origin: z.string().max(40).optional(),
    pageContext: pageContextSchema.optional(),
    // ISS-499 — session attachments to attach to this turn.
    attachmentIds: z.array(z.uuid()).max(10).optional(),
  })
  .strict()
  .refine((d) => d.message.trim().length > 0 || (d.attachmentIds?.length ?? 0) > 0, {
    message: 'message or attachmentIds required',
    path: ['message'],
  });

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

async function loadProjectBySlug(slug: string) {
  const [row] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      repoPath: projects.repoPath,
      defaultDeviceId: projects.defaultDeviceId,
    })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return row ?? null;
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
    assertProjectRole(access, 'member');

    // Single device-resolution shared with /send + schedule: desktop runs
    // Claude locally (no device); web/automation needs an online runner or 409.
    // Without a live client a non-desktop session would be created `running`
    // with no listener and hang forever (the sweeper only reaps pipeline/pm).
    const client = await resolveChatDevice(
      { projectId: project.id, deviceId: null, metadata: null },
      input.origin,
    );
    if (!client.isLocal && !client.deviceId) throw noClaudeClient('project');

    const agentName = input.type ?? 'agent';
    const rawPrompt =
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
        title = issueRows
          .map((i) => `ISS-${i.issSeq}`)
          .join(', ')
          .slice(0, 120);
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

    // ===== Agent review / reindex: a one-shot run with no follow-up turns, so
    // it does NOT ride the chat-turn dispatcher — it publishes its own
    // `agent:review` / `agent:reindex` event. Device resolution is still the
    // shared `resolveChatDevice` above so it cannot drift from chat. =====
    if (isAgentSession) {
      const deviceId = client.deviceId;
      const bindingRepo = deviceId ? await resolveRunnerRepoPath(project.id, deviceId) : null;
      const rp = resolveRepoPath(input.repoPath, bindingRepo ?? project.repoPath);
      const metadata: Record<string, unknown> = { type: input.type };
      if (deviceId) metadata.deviceId = deviceId;
      if (input.issueIds?.length === 1 && input.issueIds[0]) metadata.issueId = input.issueIds[0];

      const nowDate = new Date();
      const userMessage = { role: 'user', content: rawPrompt, timestamp: nowDate.getTime() };
      const interactiveRun = await openOneShotRun({ projectId: project.id, kind: 'interactive' });
      const { inserted, startSync } = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(agentSessions)
          .values({
            projectId: project.id,
            userId,
            deviceId,
            pipelineRunId: interactiveRun.id,
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
        const sync = await syncTurnsWithMessages(row.id, [], [userMessage], tx);
        return { inserted: row, startSync: sync };
      });
      for (const t of startSync.appended) broadcastTurnAppended(inserted, t);

      const auditIssueId = extractIssueId(inserted.metadata);
      if (auditIssueId) {
        await safeRecordActivity({
          issueId: auditIssueId,
          actor: { type: 'user', id: userId },
          action: 'agent-session.created',
          payload: { sessionId: inserted.id, title: inserted.title ?? null },
        });
      }

      if (!client.isLocal && deviceId) {
        roomManager.publish(deviceRoom(deviceId), {
          event: isReindex ? 'agent:reindex' : 'agent:review',
          data: { sessionId: inserted.id, repoPath: rp, projectSlug: input.projectSlug },
        });
      }
      broadcastSession(inserted, 'agent-session.created');
      return c.json(inserted, 201);
    }

    // ===== Interactive chat: create an empty row, then deliver turn #1 through
    // the ONE shared dispatcher — identical to a /send follow-up. =====
    const metadata: Record<string, unknown> = {};
    if (input.issueIds?.length === 1 && input.issueIds[0]) metadata.issueId = input.issueIds[0];
    const session = await createChatSessionRow({
      projectId: project.id,
      userId,
      title,
      repoPath: input.repoPath ?? null,
      metadata: Object.keys(metadata).length ? metadata : null,
    });
    const updated = await dispatchChatTurn({
      session,
      project: { id: project.id, slug: project.slug, repoPath: project.repoPath },
      client,
      message: rawPrompt,
      origin: input.origin ?? null,
      pageContext: input.pageContext ?? null,
      preBuilt: input.preBuilt ?? false,
      attachmentIds: input.attachmentIds,
      broadcastEvent: 'agent-session.created',
    });

    const auditIssueId = extractIssueId(updated.metadata);
    if (auditIssueId) {
      await safeRecordActivity({
        issueId: auditIssueId,
        actor: { type: 'user', id: userId },
        action: 'agent-session.created',
        payload: { sessionId: updated.id, title: updated.title ?? null },
      });
    }
    return c.json(updated, 201);
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
    assertProjectRole(access, 'member');
    if (session.userId && session.userId !== userId && !projectRoleAtLeast(access.role, 'admin')) {
      throw forbidden('not the session owner');
    }

    // Resolve the client through the SHARED path: honour an explicit runner pick
    // (input.deviceId) when present, else reuse the session's pinned device,
    // else pick a fresh online runner (this is what fixes the web cold start — a
    // session created empty via `POST /` has no pin, so the old pin-only guard
    // 409'd forever). No online remote client → 409; a rejected explicit pick
    // gets the 'picked' wording so the user knows their choice was unavailable.
    const client = await resolveChatDevice(session, input.origin, input.deviceId);
    if (!client.isLocal && !client.deviceId) {
      throw noClaudeClient(input.deviceId ? 'picked' : 'session');
    }

    const [project] = await db
      .select({ id: projects.id, slug: projects.slug, repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, session.projectId))
      .limit(1);
    if (!project) throw notFound('project not found');

    await dispatchChatTurn({
      session,
      project,
      client,
      message: input.message,
      origin: input.origin ?? null,
      pageContext: input.pageContext ?? null,
      claudeSessionId: input.claudeSessionId ?? null,
      attachmentIds: input.attachmentIds,
    });
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
    assertProjectRole(access, 'member');
    if (session.userId && session.userId !== userId && !projectRoleAtLeast(access.role, 'admin')) {
      throw forbidden('not the session owner');
    }

    const [updated] = await db
      .update(agentSessions)
      .set({ status: 'idle', updatedAt: new Date() })
      .where(eq(agentSessions.id, input.sessionId))
      .returning();
    if (!updated) throw notFound('agent session not found');

    // Aborting a pipeline session just flips it to `idle`; the failure path
    // (ISS-393) reverts the issue to its stage entry-status or parks it at
    // `waiting`, so there is no separate hold flag to pin here.
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
    assertProjectRole(access, 'member');
    if (session.userId && session.userId !== userId && !projectRoleAtLeast(access.role, 'admin')) {
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
    const [updated] = await applyKernelTransition(db, {
      entity: 'session',
      to: 'failed',
      set: {
        failureReason: 'user_cancelled',
        updatedAt: cancelNow,
      },
      where: and(
        eq(agentSessions.id, id),
        inArray(agentSessions.status, ['queued', 'running', 'idle']),
      ),
      fromStatus: session.status,
      reason: 'user_cancelled',
      actor: { type: 'user', id: userId },
      source: 'session-cancel',
    });
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

    // ISS-101 — close the one-shot run for cancelled interactive sessions.
    // No-op for kind='issue' (the issue state-machine owns those runs).
    await closeRunIfOneShot(updated.pipelineRunId, 'cancelled');

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
    assertProjectRole(access, 'member');

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

// GET /api/agent-sessions/:id/cost
// Per-session cost + token rollup from usage_records (ISS-378 AC#6). The session
// row itself carries no dollar cost/model, so the detail rail showed "—"; this
// aggregates usage_records WHERE session_id = this session id and groups by model
// for the per-model breakdown. usage_records.session_id is a uuid-shaped text
// column — guard the cast (mirrors issues/extras-routes.ts cost-summary) so a
// stray non-uuid value can't 500 the rollup. Mounted before `:id` GET; the extra
// path segment means no validator collision with the single-segment `/:id`.
agentSessionRoutes.get(
  '/:id/cost',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [session] = await db
      .select({ id: agentSessions.id, projectId: agentSessions.projectId })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!session) throw notFound('agent session not found');

    const access = await loadProjectAccess(session.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const sessionMatch = sql`${usageRecords.sessionId} ~ '^[0-9a-fA-F-]{36}$' AND ${usageRecords.sessionId}::uuid = ${id}`;

    const [totals] = await db
      .select({
        estimatedCost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
        inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)`.mapWith(Number),
        outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)`.mapWith(Number),
        cacheReadTokens: sql<number>`coalesce(sum(${usageRecords.cacheReadTokens}), 0)`.mapWith(
          Number,
        ),
        cacheCreationTokens:
          sql<number>`coalesce(sum(${usageRecords.cacheCreationTokens}), 0)`.mapWith(Number),
        requests: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
        sampleCount: sql<number>`count(${usageRecords.id})`.mapWith(Number),
      })
      .from(usageRecords)
      .where(sessionMatch);

    // Per-model breakdown for the detail rail's "Model" stat (one row per model
    // this session billed against), ordered by spend.
    const models = await db
      .select({
        model: usageRecords.model,
        cost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(Number),
        requests: sql<number>`coalesce(sum(${usageRecords.requestCount}), 0)`.mapWith(Number),
      })
      .from(usageRecords)
      .where(sessionMatch)
      .groupBy(usageRecords.model)
      .orderBy(desc(sql`sum(${usageRecords.estimatedCost})`));

    return c.json({
      sessionId: id,
      projectId: session.projectId,
      ...(totals ?? {
        estimatedCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requests: 0,
        sampleCount: 0,
      }),
      models,
    });
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
    if (!access.role) throw forbidden('not a project member');

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
    assertProjectRole(access, 'admin', 'owner or admin role required');

    // ISS-449 — the loop monitor owns session reaps now; the sweeper's
    // sweepZombieSessions was demoted to an alarm pass.
    const { reapZombieSessions } = await import('../jobs/loop-monitor.js');
    const result = await reapZombieSessions(new Date(), { projectId });
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
    assertProjectRole(access, 'member');

    let deviceId = await findAvailableDeviceForProject(project.id);
    if (!deviceId && project.defaultDeviceId) {
      // Last-resort fallback to the (possibly offline) default device — but honor
      // the "turn off" switch: never target a device the owner disabled.
      const [def] = await db
        .select({ disabledAt: devices.disabledAt })
        .from(devices)
        .where(eq(devices.id, project.defaultDeviceId))
        .limit(1);
      if (def && !def.disabledAt) deviceId = project.defaultDeviceId;
    }
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
    assertProjectRole(access, 'member');

    // ISS-572 — classify a usage/session-limit failure on an agent:start
    // (schedule/chat) session. The job path already routes usage limits to a
    // cross-device failover (failure-classifier v5), but agent:start sessions
    // bypass that and previously landed `failed` with `failureReason=null` —
    // silently burning a scheduled slot. Detect it here (the runner's terminal
    // report), persist a distinct reason + reset time, and (for schedule runs)
    // fail over to a device whose account still has headroom.
    let usageLimit = false;
    let limitResetAt: string | null = null;
    if (status === 'failed') {
      const { isUsageLimitError, parseUsageLimitReset } = await import(
        '../runners/limit-detect.js'
      );
      const failText = extractSessionFailureText(existing.messages, note);
      if (isUsageLimitError(failText)) {
        usageLimit = true;
        const reset = parseUsageLimitReset(failText);
        limitResetAt = reset ? reset.toISOString() : null;
      }
    }

    const statusSet: Record<string, unknown> = { status, updatedAt: new Date() };
    if (usageLimit) {
      statusSet.failureReason = 'usage_limit';
      statusSet.metadata = {
        ...((existing.metadata as Record<string, unknown> | null) ?? {}),
        ...(limitResetAt ? { limitResetAt } : {}),
      };
    }
    const [updated] = await db
      .update(agentSessions)
      .set(statusSet)
      .where(eq(agentSessions.id, sessionId))
      .returning();
    if (!updated) throw notFound('agent session not found');

    // ISS-101 — close one-shot runs on terminal status writes. No-op on
    // kind='issue' (closed by issue state-machine); fires for pm/interactive.
    if (status === 'completed' || status === 'failed') {
      await closeRunIfOneShot(updated.pipelineRunId, status === 'failed' ? 'failed' : 'completed');
    }

    // ISS-572 — recover a rate-limited SCHEDULE run by failing over to an
    // account with headroom (reuses the loop-monitor failover mechanism). If
    // no headroom device is available the schedule's next cron tick recovers
    // once the window resets. Best-effort — never breaks the status write.
    if (usageLimit) {
      const meta = (existing.metadata ?? {}) as Record<string, unknown>;
      if (meta.source === 'schedule.run') {
        try {
          const { redispatchScheduleSessionOnFailover } = await import('../schedules/dispatch.js');
          const result = await redispatchScheduleSessionOnFailover(sessionId);
          logger.info(
            { sessionId, scheduleId: meta.scheduleId, limitResetAt, result },
            'agent-sessions/desktop-status: schedule usage-limit → cross-account failover',
          );
        } catch (err) {
          logger.error(
            { err, sessionId, scheduleId: meta.scheduleId },
            'agent-sessions/desktop-status: schedule usage-limit failover threw (left failed for next cron)',
          );
        }
      }
    }

    // ISS-548/ISS-556 — schedule session completion write-back.
    // When a schedule session completes, parse the agent's embedded report and
    // persist it. Two paths based on session metadata:
    //   steward===true  → ISS-556 standing steward: persist stewardReport to
    //                     session metadata; NO appliedMessageVersions write (standing).
    //   otherwise       → ISS-548 one-shot: update appliedMessageVersions + skillImproveReport.
    // Best-effort — failures must not break the status update itself.
    if (status === 'completed') {
      const meta = existing.metadata as Record<string, unknown> | null;
      const scheduleId = meta?.scheduleId;
      const templateKey = meta?.templateKey;
      if (typeof scheduleId === 'string' && typeof templateKey === 'string') {
        try {
          const messages = Array.isArray(existing.messages) ? existing.messages : [];
          const isSteward = meta?.steward === true;

          if (isSteward) {
            // ISS-556 — standing steward: parse steward run report, persist to
            // session metadata. No appliedMessageVersions write (fires every run).
            const stewardReport = extractStewardReportFromMessages(messages);
            if (stewardReport) {
              const updatedMeta = { ...(meta ?? {}), stewardReport };
              await db
                .update(agentSessions)
                .set({ metadata: updatedMeta })
                .where(eq(agentSessions.id, sessionId));
            }
          } else {
            // ISS-548 — one-shot skill-improve: update appliedMessageVersions gate.
            const report = extractReportFromMessages(messages);
            if (report && Object.keys(report.updatedVersions).length > 0) {
              // Merge with any existing applied versions (concurrent runs are rare
              // but we prefer a max-version merge over a blind overwrite).
              const [currentRow] = await db
                .select({ appliedMessageVersions: schedules.appliedMessageVersions })
                .from(schedules)
                .where(eq(schedules.id, scheduleId))
                .limit(1);
              const existing_ =
                (currentRow?.appliedMessageVersions as Record<string, number> | null) ?? {};
              const merged: Record<string, number> = { ...existing_ };
              for (const [key, ver] of Object.entries(report.updatedVersions)) {
                merged[key] = Math.max(merged[key] ?? 0, ver);
              }
              await db
                .update(schedules)
                .set({ appliedMessageVersions: merged })
                .where(eq(schedules.id, scheduleId));
            }
            // Always persist the report in session metadata for the UI.
            if (report) {
              const updatedMeta = { ...(meta ?? {}), skillImproveReport: report.entries };
              await db
                .update(agentSessions)
                .set({ metadata: updatedMeta })
                .where(eq(agentSessions.id, sessionId));
            }
          }
        } catch (err) {
          logger.error(
            { err, sessionId, scheduleId, templateKey },
            'agent-sessions/desktop-status: schedule write-back failed',
          );
        }
      }
    }

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
    const userId = c.get('userId');

    // Non-revealing default: any caller without ownership/membership of the
    // queried target gets `connected:false` and cannot tell a real offline
    // device/slug from one that exists in another tenant (ISS-492).
    const notConnected = () => c.json({ data: { connected: false } });

    if (deviceId) {
      const [row] = await db
        .select({ status: devices.status, ownerId: devices.ownerId })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      if (!row) return notConnected();

      // Reveal the real liveness bit only to the device owner, or to a caller
      // who shares a project this device serves as a runner.
      let allowed = row.ownerId === userId;
      if (!allowed) {
        const visible = await loadVisibleProjectIds(userId);
        if (visible.length > 0) {
          const [served] = await db
            .select({ id: runners.id })
            .from(runners)
            .where(and(eq(runners.deviceId, deviceId), inArray(runners.projectId, visible)))
            .limit(1);
          allowed = served !== undefined;
        }
      }
      if (!allowed) return notConnected();

      return c.json({ data: { connected: row.status === 'online' } });
    }

    if (!projectSlug) {
      return notConnected();
    }

    const project = await loadProjectBySlug(projectSlug);
    if (!project) return notConnected();

    // Gate membership before confirming the slug has a live device — otherwise
    // the response is a slug-existence + liveness oracle for other tenants.
    const access = await loadProjectAccess(project.id, userId).catch(() => null);
    if (!access?.role) return notConnected();

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
    const { projectId, deviceId, status, metadataType, issueId, archived, page, pageSize } =
      c.req.valid('query');
    const userId = c.get('userId');

    const conditions: SQL[] = [];

    if (projectId) {
      const access = await loadProjectAccess(projectId, userId);
      if (!access.role) throw forbidden('not a project member');
      conditions.push(eq(agentSessions.projectId, projectId));
    } else if (deviceId) {
      // Scope a deviceId listing to caller-visible projects, like the
      // cross-project branch below — otherwise any authenticated user could
      // dump every session (incl. full messages[]) for a device across all
      // tenants (ISS-492). agentSessions.projectId is NOT NULL, so this fully
      // scopes the rows.
      const visible = await loadVisibleProjectIds(userId);
      if (visible.length === 0) {
        setTotalCount(c, 0);
        return c.json([]);
      }
      conditions.push(eq(agentSessions.deviceId, deviceId));
      conditions.push(inArray(agentSessions.projectId, visible));
    } else {
      // Cross-project view: restrict to caller-visible projects (explicit
      // membership of any role, or org owner/admin).
      const visible = await loadVisibleProjectIds(userId);

      if (visible.length === 0) {
        setTotalCount(c, 0);
        return c.json([]);
      }

      conditions.push(inArray(agentSessions.projectId, visible));
    }

    if (status) conditions.push(eq(agentSessions.status, status));
    if (metadataType) {
      conditions.push(sql`${agentSessions.metadata}->>'type' = ${metadataType}`);
    }
    // ISS-522 — interactive `agent` chats are private to their owner. Scope the
    // "My conversations" listing to the caller; this also drops legacy
    // userId=NULL rows (NULL never equals). Pipeline/pm/Agents-overview calls
    // (no metadataType=agent) stay project-shared.
    if (metadataType === 'agent') {
      conditions.push(eq(agentSessions.userId, userId));
    }
    if (issueId) {
      conditions.push(sql`${agentSessions.metadata}->>'issueId' = ${issueId}`);
    }
    // ISS-465 — default to excluding archived chats (metadata.archived='true').
    // `IS DISTINCT FROM` keeps rows whose metadata has no `archived` key, so
    // pipeline/pm rows and unarchived chats stay in the active list.
    if (archived === 'true') {
      conditions.push(sql`${agentSessions.metadata}->>'archived' = 'true'`);
    } else {
      conditions.push(sql`(${agentSessions.metadata}->>'archived') IS DISTINCT FROM 'true'`);
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

    // Per-row dollar cost (ISS-391): the session row carries no cost — it lives
    // in usage_records keyed by session_id. Roll it up in ONE bounded query over
    // just this page's session ids (no per-row N+1), grouped by session_id.
    // usage_records.session_id is a uuid-shaped text column → guard the cast
    // (mirrors the /:id/cost route). usage_records.session_id = agent_sessions.id
    // (NOT the job id), so filtering directly by the page's ids is correct and
    // does not fan out the way a join through jobs would.
    const costById = new Map<string, number>();
    const pageIds = rows.map((r) => r.id);
    if (pageIds.length > 0) {
      const idList = sql.join(
        pageIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const costRows = await db
        .select({
          sessionId: usageRecords.sessionId,
          estimatedCost: sql<number>`coalesce(sum(${usageRecords.estimatedCost}), 0)`.mapWith(
            Number,
          ),
        })
        .from(usageRecords)
        .where(
          sql`${usageRecords.sessionId} ~ '^[0-9a-fA-F-]{36}$' AND ${usageRecords.sessionId}::uuid IN (${idList})`,
        )
        .groupBy(usageRecords.sessionId);
      for (const cr of costRows) {
        if (cr.sessionId) costById.set(cr.sessionId, cr.estimatedCost);
      }
    }

    return c.json(rows.map((r) => ({ ...r, estimatedCost: costById.get(r.id) ?? 0 })));
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
    assertProjectRole(access, 'member');

    // Chat bootstrap: an EMPTY session row. The first turn is dispatched later
    // through `POST /send` → the shared chat-turn dispatcher (which picks the
    // device), so this path deliberately does NOT pin a device or dispatch.
    const inserted = await createChatSessionRow({
      projectId: input.projectId,
      userId,
      deviceId: input.deviceId ?? null,
      title: input.title ?? null,
      repoPath: input.repoPath ?? null,
      claudeSessionId: input.claudeSessionId ?? null,
      metadata: (input.metadata as Record<string, unknown> | null | undefined) ?? null,
    });

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

    // A CLI runner reads its own session back with a device token to use the
    // persisted `messages` as the baseline its PATCH appends onto (ISS-462). The
    // PATCH path already honors the device principal; GET must too, or the
    // baseline fetch 403s, the runner falls back to an EMPTY baseline, and every
    // turn's PATCH overwrites the whole array — dropping the user turn + all
    // prior history. Scope a device to ONLY the session dispatched to it; users
    // keep the project-membership check.
    if (c.get('principal') === 'device') {
      if (row.deviceId !== c.get('deviceId')) {
        throw forbidden('device does not own this session');
      }
    } else {
      const access = await loadProjectAccess(row.projectId, userId);
      if (!access.role) throw forbidden('not a project member');
      assertAgentChatOwner(row, access, userId);
    }

    return c.json(row);
  },
);

// ISS-584 (C) — runner ack. A CLI runner POSTs this the moment it receives an
// `agent:start`/`agent:send` frame (before claude starts), stamping
// `metadata.acked=true`. The loop-monitor uses it to fast-fail a session that
// ACKed but never produced a claudeSessionId (claude died on startup) without
// waiting the full heartbeat timeout. Device-token only + own-session scoped;
// idempotent; only flips a still-`running` session (never resurrects a terminal one).
agentSessionRoutes.post(
  '/:id/ack',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    if (c.get('principal') !== 'device') {
      throw forbidden('ack is a runner-only signal');
    }
    const [existing] = await db
      .select({
        id: agentSessions.id,
        deviceId: agentSessions.deviceId,
        status: agentSessions.status,
        metadata: agentSessions.metadata,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!existing) throw notFound('agent session not found');
    if (existing.deviceId !== c.get('deviceId')) {
      throw forbidden('device does not own this session');
    }
    const meta = (existing.metadata ?? {}) as Record<string, unknown>;
    const already = meta.acked === true;
    if (existing.status === 'running' && !already) {
      await db
        .update(agentSessions)
        .set({ metadata: { ...meta, acked: true, ackedAt: new Date().toISOString() } })
        .where(and(eq(agentSessions.id, id), eq(agentSessions.status, 'running')));
    }
    return c.json({ sessionId: id, acked: existing.status === 'running', already });
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

    // A CLI runner streams its chat reply back here with a device token. Scope
    // it tightly: a device may write ONLY the session that was dispatched to it.
    // Users (web/desktop) keep the project-membership check.
    if (c.get('principal') === 'device') {
      if (existing.deviceId !== c.get('deviceId')) {
        throw forbidden('device does not own this session');
      }
    } else {
      const access = await loadProjectAccess(existing.projectId, userId);
      assertProjectRole(access, 'member');
      if (
        existing.userId &&
        existing.userId !== userId &&
        !projectRoleAtLeast(access.role, 'admin')
      ) {
        throw forbidden('not the session owner');
      }
    }

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
    if (patch.status === undefined && isWorkerActivity && existing.status === 'queued') {
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
      .select({
        id: agentSessions.id,
        projectId: agentSessions.projectId,
        deviceId: agentSessions.deviceId,
        userId: agentSessions.userId,
        status: agentSessions.status,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!existing) throw notFound('agent session not found');

    // ISS-465 — owner-or-admin gate (was admin-only). A user can delete their
    // own chat; project owners/admins can delete any session.
    const access = await loadProjectAccess(existing.projectId, userId);
    assertProjectRole(access, 'member');
    if (
      existing.userId &&
      existing.userId !== userId &&
      !projectRoleAtLeast(access.role, 'admin')
    ) {
      throw forbidden('not the session owner');
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
      .select({
        id: agentSessions.id,
        projectId: agentSessions.projectId,
        deviceId: agentSessions.deviceId,
        status: agentSessions.status,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    if (!existing) throw notFound('agent session not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    assertProjectRole(access, 'member');

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
    if (!access.role) throw forbidden('not a project member');

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
    // Pause/resume is a privileged operation — effective admin only.
    // Plain members can read state but cannot mutate it.
    assertProjectRole(access, 'admin', 'owner or admin role required');

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
    if (!access.role) throw forbidden('not a project member');

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
    assertProjectRole(access, 'member');

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
    if (!access.role) throw forbidden('not a project member');

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
    assertProjectRole(access, 'member');

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

// ISS-522 — interactive `agent` chats are private to their owner (or a project
// admin). This is a NO-OP for pipeline/pm/no-type sessions, which stay
// project-shared. Legacy `userId = NULL` agent rows are treated as non-owner →
// only an admin can read them, so they never leak to other members. Mirrors the
// owner-or-admin guard already used by the editTurn (PATCH /:id/turns/:turnId)
// route.
function assertAgentChatOwner(
  session: { metadata: unknown; userId: string | null },
  access: Awaited<ReturnType<typeof loadProjectAccess>>,
  userId: string,
) {
  const isAgentChat = (session.metadata as { type?: string } | null)?.type === 'agent';
  if (!isAgentChat) return;
  if (session.userId !== userId && !projectRoleAtLeast(access.role, 'admin')) {
    throw forbidden('not the conversation owner');
  }
}

async function ensureSessionMember(sessionId: string, userId: string) {
  const [session] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!session) throw notFound('agent session not found');
  const access = await loadProjectAccess(session.projectId, userId);
  // Reads are project-visible: any effective role (incl. viewer) may see the
  // session. Mutating callers must additionally gate via assertProjectRole.
  if (!access.role) throw forbidden('not a project member');
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
    const { session, access } = await ensureSessionMember(id, userId);
    assertAgentChatOwner(session, access, userId);

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

    const { session, access } = await ensureSessionMember(id, userId);
    assertProjectRole(access, 'member');
    if (session.userId && session.userId !== userId && !projectRoleAtLeast(access.role, 'admin')) {
      throw forbidden('not the session owner');
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

    const { session, access } = await ensureSessionMember(id, userId);
    assertProjectRole(access, 'member');
    if (session.userId && session.userId !== userId && !projectRoleAtLeast(access.role, 'admin')) {
      throw forbidden('not the session owner');
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

    const { session, access } = await ensureSessionMember(id, userId);
    assertProjectRole(access, 'member');
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

    // ISS-101 — forks are independent interactive sessions; give each its own run.
    const forkRun = await openOneShotRun({
      projectId: session.projectId,
      kind: 'interactive',
    });
    const { inserted, seedSync } = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(agentSessions)
        .values({
          projectId: session.projectId,
          userId: session.userId,
          deviceId: session.deviceId,
          pipelineRunId: forkRun.id,
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

    const { session, access } = await ensureSessionMember(id, userId);
    assertProjectRole(access, 'member');
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
    // ISS-101 — rerun spawns a fresh interactive session with its own run.
    const rerunRun = await openOneShotRun({
      projectId: session.projectId,
      kind: 'interactive',
    });
    const { inserted, seedSync } = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(agentSessions)
        .values({
          projectId: session.projectId,
          userId: session.userId ?? userId,
          deviceId: session.deviceId,
          pipelineRunId: rerunRun.id,
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
      // Seed the project-default MCP servers (e.g. playwright) into the rerun's
      // fresh interactive Claude turn, mirroring `dispatchChatTurn` — without
      // this the re-spawned `claude` only sees the `forge` MCP. Best-effort `{}`.
      const { servers: mcpServersOverride } = await resolveProjectDefaultMcpServers(
        inserted.projectId,
      );
      roomManager.publish(deviceRoom(targetDeviceId), {
        event: 'agent:start',
        data: {
          sessionId: inserted.id,
          repoPath: inserted.repoPath ?? null,
          prompt,
          projectSlug: project?.slug ?? null,
          preBuilt: false,
          mcpServersOverride,
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
