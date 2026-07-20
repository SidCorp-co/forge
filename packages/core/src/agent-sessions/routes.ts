import { zValidator } from '@hono/zod-validator';
import { type SQL, and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  type AgentSessionStatus,
  agentSessionStatuses,
  agentSessionTurns,
  agentSessions,
  issues,
  usageRecords,
} from '../db/schema.js';
import { assertProjectRole, loadProjectAccess, loadVisibleProjectIds } from '../lib/authz.js';
import { setTotalCount } from '../lib/pagination.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireUserOrDevice } from '../middleware/auth.js';
import {
  EMPTY_USAGE_TOTALS,
  usageSessionMatch,
  usageTotalsSelection,
} from '../usage-records/rollup.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { broadcastSession, broadcastTurnAppended, broadcastTurnTruncated } from './broadcast.js';
import { extractTurnPreview } from './chat-preview.js';
import { createChatSessionRow } from './chat-turn.js';
import { agentSessionLifecycleRoutes } from './lifecycle-routes.js';
import { agentSessionPipelineControlRoutes } from './pipeline-control-routes.js';
import {
  assertAgentChatOwner,
  assertDeviceOwnsSession,
  assertSessionOwnerOrAdmin,
  badRequest,
  ensureSessionMember,
  ensureSessionOwnerOrAdmin,
  ensureSessionRole,
  forbidden,
  idParamSchema,
  loadSessionOr404,
  notFound,
} from './session-access.js';
import { recordSessionCreatedActivity } from './session-activity.js';
import { finalizeUsageLimitOnFailure } from './session-failure.js';
import { syncTurnsWithMessages } from './turns-helpers.js';
import { agentSessionTurnsRoutes } from './turns-routes.js';

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

const relayBodySchema = z
  .object({
    event: z.string().min(1).max(200),
    data: z.unknown(),
  })
  .strict();

// ISS-675 — mirrors lifecycle/transition.ts's SessionTransitionArgs['to'] enum;
// gates the escalation completion-bridge hook below to genuinely terminal
// PATCHes only.
const TERMINAL_SESSION_STATUSES: ReadonlySet<AgentSessionStatus> = new Set([
  'completed',
  'failed',
  'completed_via_recovery',
  'cancelled_stale',
]);

// `broadcastSession` is imported from `./broadcast.ts` so per-turn handlers can
// share the same fan-out shape (project room + owning device room).

export const agentSessionRoutes = new Hono<{ Variables: AuthVars }>();
// Dual-auth: user JWT (web/desktop) OR device token (a CLI runner streaming a
// chat reply back via PATCH /:id). Non-device routes still authorize via
// `loadProjectAccess(_, userId)`, which fails closed for a device principal.
agentSessionRoutes.use('*', requireUserOrDevice(), assertEmailVerified());

// Static-path lifecycle handlers (start / send / abort / cancel / build-prompt
// / prompt-built / desktop-status) — mounted FIRST so they keep beating the
// `:id` handlers below, exactly like the pre-split registration order.
agentSessionRoutes.route('/', agentSessionLifecycleRoutes);

// Pipeline-session types for the retry endpoint. Mirrors the predicate
// used by sweeper.ts and the migration backfill.
const PIPELINE_SESSION_TYPES = new Set<string>(['pipeline', 'pm']);

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

    const { session } = await ensureSessionRole(id, userId, 'member');

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

    const { session } = await ensureSessionMember(id, userId);

    const sessionMatch = usageSessionMatch(sql`= ${id}`);

    const [totals] = await db
      .select(usageTotalsSelection())
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
      ...(totals ?? EMPTY_USAGE_TOTALS),
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
    // Last-message preview (ISS-698): one bounded DISTINCT ON query over this
    // page's ids, mirroring the cost rollup above — no per-row N+1. Excludes
    // `tool` turns (no text to preview); a session with no user/assistant text
    // turn yet (e.g. only a materialized-jsonb legacy row) resolves to null.
    const previewById = new Map<string, string>();
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
        .where(usageSessionMatch(sql`IN (${idList})`))
        .groupBy(usageRecords.sessionId);
      for (const cr of costRows) {
        if (cr.sessionId) costById.set(cr.sessionId, cr.estimatedCost);
      }

      const previewRows = (await db.execute(sql`
        SELECT DISTINCT ON (${agentSessionTurns.agentSessionId}) ${agentSessionTurns.agentSessionId} AS session_id, ${agentSessionTurns.content} AS content
        FROM ${agentSessionTurns}
        WHERE ${agentSessionTurns.agentSessionId} IN (${idList}) AND ${agentSessionTurns.role} <> 'tool'
        ORDER BY ${agentSessionTurns.agentSessionId}, ${agentSessionTurns.turnIndex} DESC
      `)) as unknown as Array<{ session_id: string; content: unknown }>;
      for (const pr of previewRows) {
        // Row storage wraps the original message entry as `{ value: entry }`
        // (see normalizeTurnContent in turns-helpers.ts); the entry itself is
        // `{ role/type, content, ... }`, so the previewable text is one level
        // further in at `value.content`, not `value` itself.
        const entryValue = (pr.content as { value?: unknown } | null)?.value;
        const entryContent =
          entryValue && typeof entryValue === 'object'
            ? (entryValue as { content?: unknown }).content
            : undefined;
        const preview = extractTurnPreview(entryContent);
        if (preview) previewById.set(pr.session_id, preview);
      }
    }

    return c.json(
      rows.map((r) => ({
        ...r,
        estimatedCost: costById.get(r.id) ?? 0,
        lastMessagePreview: previewById.get(r.id) ?? null,
      })),
    );
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

    await recordSessionCreatedActivity(inserted, userId);

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

    const row = await loadSessionOr404(id);

    // A CLI runner reads its own session back with a device token to use the
    // persisted `messages` as the baseline its PATCH appends onto (ISS-462). The
    // PATCH path already honors the device principal; GET must too, or the
    // baseline fetch 403s, the runner falls back to an EMPTY baseline, and every
    // turn's PATCH overwrites the whole array — dropping the user turn + all
    // prior history. Scope a device to ONLY the session dispatched to it; users
    // keep the project-membership check.
    if (c.get('principal') === 'device') {
      assertDeviceOwnsSession(c, row);
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
    const existing = await loadSessionOr404(id);
    assertDeviceOwnsSession(c, existing);
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

    const existing = await loadSessionOr404(id);

    // A CLI runner streams its chat reply back here with a device token. Scope
    // it tightly: a device may write ONLY the session that was dispatched to it.
    // Users (web/desktop) keep the project-membership check.
    if (c.get('principal') === 'device') {
      assertDeviceOwnsSession(c, existing);
    } else {
      const access = await loadProjectAccess(existing.projectId, userId);
      assertProjectRole(access, 'member');
      assertSessionOwnerOrAdmin(existing, access, userId);
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

    // ISS-572 — chat/schedule sessions finalize HERE (the runner's patch_failed
    // → patch_session), not /desktop/status. Classify a usage/session-limit
    // failure so the run-log stops recording a bare 'failed' + null reason, and
    // (for schedule runs) fail over to an account with headroom after the write.
    const usageLimit =
      patch.status === 'failed' && !isUserCancelled && existing.failureReason !== 'user_cancelled'
        ? await finalizeUsageLimitOnFailure({
            sessionId: id,
            messages: patch.messages ?? existing.messages,
            note: null,
            baseMetadata:
              (updates.metadata as Record<string, unknown> | undefined) ??
              (existing.metadata as Record<string, unknown> | null) ??
              {},
            set: updates,
          })
        : null;

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

    // ISS-572 — after persisting the classified usage_limit reason, recover a
    // rate-limited schedule run via cross-account failover (best-effort).
    if (usageLimit) {
      await usageLimit.recoverAfterWrite(updated.metadata ?? existing.metadata);
    }

    // ISS-675 — this PATCH is the runner's happy-path completion write (a
    // direct db.update, NOT applyKernelTransition — see lifecycle/transition.ts
    // for the other terminal writers). An escalation session's completion
    // bridge must fire from here too, or a class of escalations (the runner
    // finishing normally) would hang silent. Best-effort: never fail the
    // runner's PATCH over a room-reply problem.
    if (
      patch.status !== undefined &&
      TERMINAL_SESSION_STATUSES.has(patch.status) &&
      (updated.metadata as { escalation?: unknown } | null)?.escalation
    ) {
      try {
        const { deliverEscalationReplyOnce } = await import(
          '../integrations/rocketchat/escalation-bridge.js'
        );
        await deliverEscalationReplyOnce(updated);
      } catch (err) {
        logger.error({ err, sessionId: updated.id }, 'agent-sessions: escalation bridge failed');
      }
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

    // ISS-465 — owner-or-admin gate (was admin-only). A user can delete their
    // own chat; project owners/admins can delete any session.
    const { session: existing } = await ensureSessionOwnerOrAdmin(id, userId);

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

    const { session: existing } = await ensureSessionRole(id, userId, 'member');

    broadcastSession(existing, `agent-session.relay.${event}`, { payload: data });
    return c.json({ relayed: true });
  },
);

// Pipeline pause/health/telemetry control surface (GET/POST ×3).
agentSessionRoutes.route('/', agentSessionPipelineControlRoutes);

// Per-turn handlers: /turns, /turns/:turnId (+ regenerate), /fork, /rerun.
agentSessionRoutes.route('/', agentSessionTurnsRoutes);
