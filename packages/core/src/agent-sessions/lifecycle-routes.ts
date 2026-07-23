import { randomUUID } from 'node:crypto';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray } from 'drizzle-orm';
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
  runners,
  schedules,
} from '../db/schema.js';
import { assertProjectRole, loadProjectAccess, loadVisibleProjectIds } from '../lib/authz.js';
import {
  findAvailableDeviceForProject,
  resolveRepoPath,
  resolveRunnerRepoPath,
} from '../lib/device-pool.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import type { AuthVars } from '../middleware/auth.js';
import { closeRunIfOneShot, openOneShotRun } from '../pipeline/runs.js';
import { extractReportFromMessages } from '../schedules/messages/skill-improve-prompt.js';
import { extractStewardReportFromMessages } from '../schedules/messages/skill-steward-prompt.js';
import { resolveRegisteredEffectiveSkills } from '../skills/effective.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { broadcastSession, broadcastTurnAppended } from './broadcast.js';
import {
  createChatSessionRow,
  dispatchChatTurn,
  noClaudeClient,
  resolveChatDevice,
} from './chat-turn.js';
import { pageContextSchema } from './page-context.js';
import {
  badRequest,
  ensureSessionOwnerOrAdmin,
  ensureSessionRole,
  idParamSchema,
  notFound,
} from './session-access.js';
import { recordSessionCreatedActivity } from './session-activity.js';
import { finalizeUsageLimitOnFailure } from './session-failure.js';
import { syncTurnsWithMessages } from './turns-helpers.js';

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
    // ISS-733 — run an install_only project skill as turn 1 (chat-runs-skill).
    // Validated below against the project's registered effective skills so an
    // arbitrary caller cannot slash-inject a skill it hasn't been granted.
    skillName: z.string().min(1).max(128).optional(),
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

const desktopStatusSchema = z
  .object({
    sessionId: z.uuid(),
    status: z.enum(agentSessionStatuses),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();

export async function loadProjectBySlug(slug: string) {
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

// NOTE: no auth middleware here — the aggregator (`routes.ts`) applies
// `requireUserOrDevice() + assertEmailVerified()` once for the whole
// `/api/agent-sessions` surface before mounting this router.
export const agentSessionLifecycleRoutes = new Hono<{ Variables: AuthVars }>();

agentSessionLifecycleRoutes.post(
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

      await recordSessionCreatedActivity(inserted, userId);

      if (!client.isLocal && deviceId) {
        roomManager.publish(deviceRoom(deviceId), {
          event: isReindex ? 'agent:reindex' : 'agent:review',
          data: { sessionId: inserted.id, repoPath: rp, projectSlug: input.projectSlug },
        });
      }
      broadcastSession(inserted, 'agent-session.created');
      return c.json(inserted, 201);
    }

    // ISS-733 — a skillName must resolve to an install_only effective skill for
    // THIS project before it can ride turn 1 as a slash-command; otherwise any
    // caller could slash-inject an arbitrary command via /start.
    if (input.skillName) {
      const effective = await resolveRegisteredEffectiveSkills(project.id);
      if (!effective.some((s) => s.name === input.skillName && s.installOnly)) {
        throw badRequest({
          message: `skillName '${input.skillName}' is not install_only for this project`,
        });
      }
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
      skillName: input.skillName ?? null,
      broadcastEvent: 'agent-session.created',
    });

    await recordSessionCreatedActivity(updated, userId);
    return c.json(updated, 201);
  },
);

agentSessionLifecycleRoutes.post(
  '/send',
  zValidator('json', sendBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const { session } = await ensureSessionOwnerOrAdmin(input.sessionId, userId);

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

agentSessionLifecycleRoutes.post(
  '/abort',
  zValidator('json', abortBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    await ensureSessionOwnerOrAdmin(input.sessionId, userId);

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

// /cancel marks terminal as `failed` with reason='user_cancelled' (vs
// /abort which sets 'idle' so the user can resume). The sweeper then
// routes the linked job through recovery or escalation.
agentSessionLifecycleRoutes.post(
  '/:id/cancel',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const { session } = await ensureSessionOwnerOrAdmin(id, userId);

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

agentSessionLifecycleRoutes.post(
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
agentSessionLifecycleRoutes.post(
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
agentSessionLifecycleRoutes.post(
  '/desktop/status',
  zValidator('json', desktopStatusSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { sessionId, status, note } = c.req.valid('json');
    const userId = c.get('userId');

    const { session: existing } = await ensureSessionRole(sessionId, userId, 'member');

    const statusSet: Record<string, unknown> = { status, updatedAt: new Date() };

    // ISS-572 — classify a usage/session-limit failure on an agent:start
    // (schedule/chat) session. The job path already routes usage limits to a
    // cross-device failover (failure-classifier v5), but agent:start sessions
    // bypass that and previously landed `failed` with `failureReason=null` —
    // silently burning a scheduled slot. Detect it here (the runner's terminal
    // report), persist a distinct reason + reset time, and (for schedule runs)
    // fail over to a device whose account still has headroom.
    const usageLimit =
      status === 'failed'
        ? await finalizeUsageLimitOnFailure({
            sessionId,
            messages: existing.messages,
            note,
            baseMetadata: (existing.metadata as Record<string, unknown> | null) ?? {},
            set: statusSet,
          })
        : null;

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
    // account with headroom (see recoverScheduleOnUsageLimit).
    if (usageLimit) {
      await usageLimit.recoverAfterWrite(existing.metadata);
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

agentSessionLifecycleRoutes.get(
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
