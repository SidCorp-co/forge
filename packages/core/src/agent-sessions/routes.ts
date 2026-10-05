import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  type AgentSessionStatus,
  agentSessionStatuses,
  sessionRuntimeStates,
  terminalAgentSessionStatuses,
} from '../db/schema.js';
import { isPipelineSessionKind } from '../jobs/index.js';
import { loadProjectAccess, loadVisibleProjectIds } from '../lib/authz.js';
import { logger } from '../lib/logger.js';
import { fromPage, listResponse } from '../lib/pagination.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireUserOrDevice,
  restActor,
} from '../middleware/auth.js';
import { forbidden } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { broadcastSession, broadcastTurnSync } from './broadcast.js';
import { syncRunnerHealthFromChatTerminal } from './chat-runner-health.js';
import { agentSessionEventsRoutes } from './events-routes.js';
import { agentSessionInboxRoutes } from './inbox-routes.js';
import { agentSessionInteractiveRoutes } from './interactive-routes.js';
import { kindFromQuery } from './kind-query.js';
import { agentSessionLifecycleRoutes } from './lifecycle-routes.js';
import { applyTranscriptPatch } from './patch-transcript.js';
import { agentSessionPipelineControlRoutes } from './pipeline-control-routes.js';
import {
  type AgentSessionListFilter,
  linkedIssueOf,
  listAgentSessionsPage,
  sessionCost,
  sessionQueueDepth,
} from './read.js';
import { refuseSession } from './refusals.js';
import {
  BLIND_SCHEDULE_RUN_REASON,
  countTranscriptToolCalls,
  isBlindScheduleRun,
} from './schedule-evidence.js';
import { deleteSession, markSessionAcked, writeSessionPatch } from './service.js';
import {
  assertAgentChatOwner,
  assertDeviceOwnsSession,
  assertSessionOwnerOrAdmin,
  badRequest,
  ensureSessionMember,
  ensureSessionOwnerOrAdmin,
  ensureSessionRole,
  idParamSchema,
  loadSessionOr404,
} from './session-access.js';
import {
  type AgentSessionPatch,
  detectUnexpandedSkillFailure,
  finalizeScheduleSessionFailure,
} from './session-failure.js';
import { agentSessionTurnsRoutes } from './turns-routes.js';

const listQuerySchema = z
  .object({
    projectId: z.uuid().optional(),
    deviceId: z.uuid().optional(),
    status: z.enum(agentSessionStatuses).optional(),
    metadataType: z.string().min(1).max(100).optional(),
    issueId: z.uuid().optional(),
    archived: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
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
    toolCallCount: z.number().int().min(0).optional(),
    turnError: z.string().max(4000).optional(),
    runtimeState: z.enum(sessionRuntimeStates).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const relayBodySchema = z
  .object({
    event: z.string().min(1).max(200),
    data: z.unknown(),
  })
  .strict();

const TERMINAL_SESSION_STATUSES: ReadonlySet<AgentSessionStatus> = new Set(
  terminalAgentSessionStatuses,
);

export const agentSessionRoutes = new Hono<{ Variables: AuthVars }>();
agentSessionRoutes.use('*', requireUserOrDevice(), assertEmailVerified());

agentSessionRoutes.route('/', agentSessionLifecycleRoutes);
agentSessionRoutes.route('/', agentSessionInteractiveRoutes);
agentSessionRoutes.route('/', agentSessionInboxRoutes);
agentSessionRoutes.route('/', agentSessionEventsRoutes);

// A retry offers the issue to the project's masters again; while a job is still
// active for it, or no box serves the project, it is refused by name.
agentSessionRoutes.post('/:id/retry', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');

  const { session } = await ensureSessionRole(id, userId, 'project.write');

  const meta = (session.metadata ?? {}) as { issueId?: string };
  if (!isPipelineSessionKind(session.kind)) {
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

  const issue = await linkedIssueOf(meta.issueId);
  if (!issue) {
    throw new HTTPException(404, {
      message: 'linked issue not found',
      cause: { code: 'ISSUE_NOT_FOUND' },
    });
  }

  // Lazy-import breaks the agent-sessions ↔ pipeline import cycle.
  const { retryIssueDispatch } = await import('../pipeline/index.js');
  const offered = await retryIssueDispatch({
    projectId: issue.projectId,
    issueId: issue.id,
    status: issue.status,
  });

  return c.json({ ok: true, issueId: issue.id, ...offered });
});

agentSessionRoutes.get('/:id/cost', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');

  const { session } = await ensureSessionMember(id, userId);

  const { totals, models } = await sessionCost(id);
  return c.json({ sessionId: id, projectId: session.projectId, ...totals, models });
});

// Queue depth per device — backs the worker panel + session placeholder.
const queueStatsQuerySchema = z
  .object({
    projectId: z.uuid(),
  })
  .strict();

agentSessionRoutes.get('/queue-stats', zValidator('query', queueStatsQuerySchema), async (c) => {
  const { projectId } = c.req.valid('query');
  const userId = c.get('userId');

  const access = await loadProjectAccess(projectId, userId);
  requireHeld(access, 'project.read');

  // Group counts by deviceId × status. Devices without any active session
  // simply don't appear; the UI lists those via the standard devices API.
  const rows = await sessionQueueDepth(projectId);

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
});

// Manual sweep trigger — flush zombies without waiting for the cron tick.
const sweepQuerySchema = z
  .object({
    projectId: z.uuid(),
  })
  .strict();

agentSessionRoutes.post('/sweep-zombies', zValidator('query', sweepQuerySchema), async (c) => {
  const { projectId } = c.req.valid('query');
  const userId = c.get('userId');

  const access = await loadProjectAccess(projectId, userId);
  requireHeld(access, 'project.admin');

  // ISS-449 — the loop monitor owns session reaps now; the sweeper's
  // sweepZombieSessions was demoted to an alarm pass.
  const { reapZombieSessions } = await import('../jobs/index.js');
  const result = await reapZombieSessions(new Date(), { projectId });
  return c.json(result);
});

agentSessionRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const { projectId, deviceId, status, metadataType, issueId, archived, page, pageSize } =
    c.req.valid('query');
  const userId = c.get('userId');

  let scope: AgentSessionListFilter['scope'];
  if (projectId) {
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    scope = { projectId };
  } else {
    // A deviceId listing is scoped to caller-visible projects too, or any
    // authenticated user could dump a device's sessions across tenants (ISS-492).
    const visible = await loadVisibleProjectIds(userId);
    if (visible.length === 0) {
      return c.json(listResponse(c, [], 0, fromPage(page, pageSize)));
    }
    scope = { visibleProjectIds: visible, deviceId };
  }

  const { items, total } = await listAgentSessionsPage({
    scope,
    status,
    kind: metadataType ? kindFromQuery(metadataType, badRequest) : undefined,
    issueId,
    archived: archived === 'true',
    page,
    pageSize,
  });
  return c.json(listResponse(c, items, total, fromPage(page, pageSize)));
});

agentSessionRoutes.get('/:id', zValidator('param', idParamSchema), async (c) => {
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
    requireHeld(access, 'project.read');
    assertAgentChatOwner(row, access, userId);
  }

  return c.json(row);
});

// ISS-584 (C) — runner ack. A CLI runner POSTs this the moment it receives an
// `agent:start`/`agent:send` frame (before claude starts), stamping
// `metadata.acked=true`. The loop-monitor uses it to fast-fail a session that
// ACKed but never produced a claudeSessionId (claude died on startup) without
// waiting the full heartbeat timeout. Device-token only + own-session scoped;
// idempotent; only flips a still-`running` session (never resurrects a terminal one).
agentSessionRoutes.post('/:id/ack', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  if (c.get('principal') !== 'device') {
    throw forbidden('ack is a runner-only signal');
  }
  const existing = await loadSessionOr404(id);
  assertDeviceOwnsSession(c, existing);
  const meta = (existing.metadata ?? {}) as Record<string, unknown>;
  const already = meta.acked === true;
  if (existing.status === 'running' && !already) await markSessionAcked(id, meta);
  return c.json({ sessionId: id, acked: existing.status === 'running', already });
});

agentSessionRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema),
  zValidator('json', patchSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    let existing = await loadSessionOr404(id);

    // A CLI runner streams its chat reply back here with a device token. Scope
    // it tightly: a device may write ONLY the session that was dispatched to it.
    // Users (web/desktop) keep the project-membership check.
    if (c.get('principal') === 'device') {
      assertDeviceOwnsSession(c, existing);
    } else {
      const access = await loadProjectAccess(existing.projectId, userId);
      requireHeld(access, 'project.write');
      assertSessionOwnerOrAdmin(existing, access, userId);
    }

    const transcript = await applyTranscriptPatch({
      sessionId: id,
      isDevice: c.get('principal') === 'device',
      isTerminal: patch.status !== undefined && TERMINAL_SESSION_STATUSES.has(patch.status),
      patch,
    });
    const patchedMessages = transcript.messages;
    const derivedTranscript = transcript.derived;
    if (derivedTranscript) existing = await loadSessionOr404(id);

    const patchNow = new Date();
    const updates: AgentSessionPatch = { updatedAt: patchNow };
    if (patch.title !== undefined) updates.title = patch.title;
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.claudeSessionId !== undefined) updates.claudeSessionId = patch.claudeSessionId;
    if (patch.runtimeState !== undefined && c.get('principal') === 'device') {
      updates.runtimeState = patch.runtimeState;
    }
    if (patch.repoPath !== undefined) updates.repoPath = patch.repoPath;
    if (patch.usage !== undefined) updates.usage = patch.usage;
    if (patch.metadata !== undefined) updates.metadata = patch.metadata;
    if (patch.diff !== undefined) updates.diff = patch.diff;
    if (patchedMessages !== undefined) updates.messages = patchedMessages;

    const isWorkerActivity =
      (patch.runtimeState !== undefined && patch.runtimeState !== 'awaiting_input') ||
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
      throw refuseSession('SESSION_CANCELLED', 'session was cancelled by user');
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
      updates.failureDetail = null;
    }

    const existingMetaForSkillCheck = (existing.metadata as Record<string, unknown> | null) ?? null;
    const pendingSkillName =
      typeof existingMetaForSkillCheck?.pendingSkillName === 'string'
        ? existingMetaForSkillCheck.pendingSkillName
        : null;
    if (pendingSkillName && (patch.status === 'completed' || patch.status === 'failed')) {
      if (patch.status === 'completed') {
        // Prefer the pre-turn baseline stamped in chat-turn.ts (the message
        // count right after the user turn, before any assistant reply) over
        // `existing.messages.length` — an interim `running` PATCH may have
        // already persisted this turn's assistant messages before this
        // terminal PATCH lands, which would make a freshly-recomputed count
        // include them and slice them out of the scan.
        const priorCount =
          typeof existingMetaForSkillCheck?.pendingSkillBaselineCount === 'number'
            ? existingMetaForSkillCheck.pendingSkillBaselineCount
            : Array.isArray(existing.messages)
              ? existing.messages.length
              : 0;
        const unexpanded = detectUnexpandedSkillFailure(
          patchedMessages ?? existing.messages,
          pendingSkillName,
          priorCount,
        );
        if (unexpanded) {
          updates.status = 'failed';
          updates.failureReason = 'skill_not_synced';
        }
      }
      const metaBase =
        (updates.metadata as Record<string, unknown> | undefined) ??
        existingMetaForSkillCheck ??
        {};
      const {
        pendingSkillName: _droppedPendingSkillName,
        pendingSkillBaselineCount: _droppedPendingSkillBaselineCount,
        ...restMeta
      } = metaBase;
      updates.metadata = restMeta;
    }

    const reportedToolCalls = derivedTranscript
      ? countTranscriptToolCalls(existing.messages)
      : patch.toolCallCount;
    if (reportedToolCalls !== undefined && c.get('principal') === 'device') {
      const metaBase =
        (updates.metadata as Record<string, unknown> | undefined) ??
        existingMetaForSkillCheck ??
        {};
      updates.metadata = { ...metaBase, toolCallCount: reportedToolCalls };
    }
    if (
      isBlindScheduleRun({
        resolvedStatus: (updates.status as AgentSessionStatus | undefined) ?? patch.status,
        metadata:
          (updates.metadata as Record<string, unknown> | undefined) ?? existingMetaForSkillCheck,
        toolCallCount: reportedToolCalls,
        principal: c.get('principal'),
      })
    ) {
      updates.status = 'failed';
      updates.failureReason = BLIND_SCHEDULE_RUN_REASON;
      logger.warn(
        { sessionId: id, scheduleId: existingMetaForSkillCheck?.scheduleId },
        'agent-sessions: scheduled run reported completed having called no tool — recording it blind',
      );
    }

    const classification =
      patch.status === 'failed' && !isUserCancelled && existing.failureReason !== 'user_cancelled'
        ? await finalizeScheduleSessionFailure({
            sessionId: id,
            messages: patchedMessages ?? existing.messages,
            note: null,
            baseMetadata:
              (updates.metadata as Record<string, unknown> | undefined) ??
              (existing.metadata as Record<string, unknown> | null) ??
              {},
            set: updates,
          })
        : null;

    if (
      (updates.status ?? existing.status) === 'completed' &&
      existing.failureReason &&
      existing.failureReason !== 'user_cancelled'
    ) {
      updates.failureReason = null;
      updates.failureDetail = null;
    }

    // Dual-write: the messages array and agent_session_turns are written in one
    // transaction so the legacy blob and turn rows can never diverge.
    const { status: nextStatus, ...columns } = updates;
    const { updated: written, sync } = await writeSessionPatch({
      sessionId: id,
      existing,
      columns,
      to: nextStatus,
      actor:
        c.get('principal') === 'device' ? { type: 'runner', id: existing.deviceId } : restActor(c),
      snapshot: transcript.snapshot && patchedMessages ? patchedMessages : null,
      messages: patch.messages !== undefined ? (patchedMessages ?? []) : null,
      at: patchNow,
    });
    const updated = written;

    if (sync) broadcastTurnSync(updated, sync);

    if (patch.status !== undefined && patch.status !== existing.status) {
      broadcastSession(updated, 'agent-session.status');
    } else {
      broadcastSession(updated, 'agent-session.updated');
    }

    if (classification) {
      await classification.recoverAfterWrite(updated.metadata ?? existing.metadata);
    }

    await syncRunnerHealthFromChatTerminal({
      sessionId: id,
      projectId: updated.projectId,
      deviceId: updated.deviceId,
      principal: c.get('principal'),
      reportedStatus: patch.status,
      persistedStatus: updated.status,
      isUserCancelled,
      messages: patchedMessages ?? existing.messages,
    });

    return c.json(updated);
  },
);

agentSessionRoutes.delete('/:id', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');

  // ISS-465 — owner-or-admin gate (was admin-only). A user can delete their
  // own chat; project owners/admins can delete any session.
  const { session: existing } = await ensureSessionOwnerOrAdmin(id, userId);

  await deleteSession(id);
  broadcastSession(existing, 'agent-session.deleted');
  return c.body(null, 204);
});

agentSessionRoutes.post(
  '/:id/relay',
  zValidator('param', idParamSchema),
  zValidator('json', relayBodySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { event, data } = c.req.valid('json');
    const userId = c.get('userId');

    const { session: existing } = await ensureSessionRole(id, userId, 'project.write');

    broadcastSession(existing, `agent-session.relay.${event}`, { payload: data });
    return c.json({ relayed: true });
  },
);

// Pipeline pause/health/telemetry control surface (GET/POST ×3).
agentSessionRoutes.route('/', agentSessionPipelineControlRoutes);

// Per-turn handlers: /turns, /turns/:turnId (+ regenerate), /fork, /rerun.
agentSessionRoutes.route('/', agentSessionTurnsRoutes);

export { agentSessionAttachmentRoutes } from './attachment-routes.js';
export { agentSessionProjectReadRoutes } from './project-read-routes.js';
