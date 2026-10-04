import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentSessions, devices, projects, runners } from '../db/schema.js';
import { loadProjectAccess, loadVisibleProjectIds } from '../lib/authz.js';
import {
  findAvailableDeviceForProject,
  findChatCapableDeviceForProject,
  resolveSessionRepoPathForDevice,
} from '../lib/device-pool.js';
import { LIVE_SESSION_STATUSES, SESSION_MACHINE } from '@forge/contracts/session-machine';
import { notAnEdgeError } from '../lifecycle/transition.js';
import { transitionSessions } from './session-transition.js';
import { logger } from '../logger.js';
import { type AuthVars, restActor } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { closeRunIfOneShot } from '../pipeline/runs.js';
import { extractReportFromMessages } from '../schedules/messages/skill-improve-prompt.js';
import { mergeAppliedMessageVersions } from '../schedules/service.js';
import { extractStewardReportFromMessages } from '../schedules/messages/skill-steward-prompt.js';
import { deviceRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { broadcastSession } from './broadcast.js';
import { checkoutUnbound, noClaudeClient } from './chat-turn.js';
import { abortBodySchema, desktopStatusSchema, setRunnerBodySchema } from './lifecycle-schemas.js';
import {
  badRequest,
  ensureSessionOwnerOrAdmin,
  ensureSessionRole,
  idParamSchema,
  notFound,
} from './session-access.js';
import { type AgentSessionPatch, finalizeScheduleSessionFailure } from './session-failure.js';
import { holds } from '../permissions/index.js';

export async function loadProjectBySlug(slug: string) {
  const [row] = await db
    .select({
      id: projects.id,
      slug: projects.slug,
    })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return row ?? null;
}

export const agentSessionLifecycleRoutes = new Hono<{ Variables: AuthVars }>();

agentSessionLifecycleRoutes.post(
  '/abort',
  zValidator('json', abortBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const { session } = await ensureSessionOwnerOrAdmin(input.sessionId, userId);

    const [updated] = (
      await transitionSessions(db, {
        to: 'idle',
        set: { updatedAt: new Date() },
        where: eq(agentSessions.id, input.sessionId),
        actor: restActor(c),
        source: 'session-abort',
      })
    ).rows;
    if (!updated) throw notAnEdgeError(SESSION_MACHINE, session.status, 'idle');

    // Aborting a pipeline session just flips it to `idle`; the failure path
    // (ISS-393) reverts the issue to its stage entry-status or holds the job,
    // so there is no separate hold flag to pin here.
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
    const [updated] = (
      await transitionSessions(db, {
        to: 'failed',
        set: {
          failureReason: 'user_cancelled',
          updatedAt: cancelNow,
        },
        where: and(eq(agentSessions.id, id), inArray(agentSessions.status, LIVE_SESSION_STATUSES)),
        reason: 'user_cancelled',
        actor: restActor(c),
        source: 'session-cancel',
      })
    ).rows;
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
  '/:id/runner',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', setRunnerBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const { session } = await ensureSessionOwnerOrAdmin(id, userId);

    if (session.status === 'running' || session.status === 'queued') {
      throw new HTTPException(409, {
        message:
          'The agent is still working on this conversation. Wait for it to finish or stop it, then switch runner.',
        cause: { code: 'SESSION_BUSY' },
      });
    }

    const prevMeta = (session.metadata ?? {}) as Record<string, unknown> & {
      deviceId?: string | undefined;
    };
    const pinned = prevMeta.deviceId ?? session.deviceId ?? null;

    if (input.deviceId === pinned) return c.json(session);

    let picked: string | null = null;
    if (input.deviceId) {
      picked = await findChatCapableDeviceForProject(session.projectId, input.deviceId);
      if (!picked) throw noClaudeClient('picked');
    }

    const nextMeta = { ...prevMeta };
    nextMeta.deviceId = picked ?? undefined;

    const repoPath = picked
      ? await resolveSessionRepoPathForDevice(session.projectId, picked)
      : null;
    if (picked && !repoPath) throw checkoutUnbound(session.projectId, picked);

    const [updated] = await db
      .update(agentSessions)
      .set({
        deviceId: picked,
        metadata: nextMeta as never,
        claudeSessionId: null,
        repoPath,
        updatedAt: new Date(),
      })
      .where(eq(agentSessions.id, id))
      .returning();
    if (!updated) throw notFound('agent session not found');

    broadcastSession(updated, 'agent-session.updated');
    return c.json(updated);
  },
);

agentSessionLifecycleRoutes.post(
  '/desktop/status',
  zValidator('json', desktopStatusSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { sessionId, status, note } = c.req.valid('json');
    const userId = c.get('userId');

    const { session: existing } = await ensureSessionRole(sessionId, userId, 'project.write');

    const statusSet: AgentSessionPatch = { status, updatedAt: new Date() };

    const classification =
      status === 'failed'
        ? await finalizeScheduleSessionFailure({
            sessionId,
            messages: existing.messages,
            note,
            baseMetadata: (existing.metadata as Record<string, unknown> | null) ?? {},
            set: statusSet,
          })
        : null;

    const { status: _to, ...columns } = statusSet;
    const [updated] = (
      await transitionSessions(db, {
        to: status,
        set: columns,
        where: eq(agentSessions.id, sessionId),
        actor: restActor(c),
        source: 'desktop-status',
      })
    ).rows;
    if (!updated) throw notAnEdgeError(SESSION_MACHINE, existing.status, status);

    // ISS-101 — close one-shot runs on terminal status writes. No-op on
    // kind='issue' (closed by issue state-machine); fires for pm/interactive.
    if (status === 'completed' || status === 'failed') {
      await closeRunIfOneShot(updated.pipelineRunId, status === 'failed' ? 'failed' : 'completed');
    }

    if (classification) {
      await classification.recoverAfterWrite(existing.metadata);
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
              await mergeAppliedMessageVersions(scheduleId, report.updatedVersions);
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
    if (!access || !holds(access, 'project.read')) return notConnected();

    const available = await findAvailableDeviceForProject(project.id);
    return c.json({ data: { connected: available !== null } });
  },
);
