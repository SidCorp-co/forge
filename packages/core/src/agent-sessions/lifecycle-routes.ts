import { Hono } from 'hono';
import {
  findChatCapableDeviceForProject,
  resolveSessionRepoPathForDevice,
} from '../lib/device-pool.js';
import { deviceRoom, roomManager } from '../lib/rooms.js';
import { type AuthVars, restActor } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { closeRunIfOneShot } from '../pipeline/index.js';
import { broadcastSession } from './broadcast.js';
import { checkoutUnbound, noClaudeClient } from './chat-turn.js';
import { abortBodySchema, setRunnerBodySchema } from './lifecycle-schemas.js';
import { refuseSession } from './refusals.js';
import { abortSession, cancelSession, rebindSessionRunner } from './service.js';
import {
  ensureSessionOwnerOrAdmin,
  idParamSchema,
  loadSessionOr404,
  notFound,
} from './session-access.js';

export const agentSessionLifecycleRoutes = new Hono<{ Variables: AuthVars }>();

agentSessionLifecycleRoutes.post('/abort', zValidator('json', abortBodySchema), async (c) => {
  const input = c.req.valid('json');
  const userId = c.get('userId');

  const { session } = await ensureSessionOwnerOrAdmin(input.sessionId, userId);

  const updated = await abortSession(input.sessionId, session.status, restActor(c));

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
});

// /cancel marks terminal as `failed` with reason='user_cancelled' (vs
// /abort which sets 'idle' so the user can resume). The sweeper then
// routes the linked job through recovery or escalation.
agentSessionLifecycleRoutes.post('/:id/cancel', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');

  const { session } = await ensureSessionOwnerOrAdmin(id, userId);

  if (session.status === 'completed' || session.status === 'failed') {
    // Already terminal — return current state, idempotent.
    return c.json(session);
  }

  const updated = await cancelSession(id, restActor(c));
  if (!updated) {
    // CAS lost — return the current row so the client can re-render.
    return c.json(await loadSessionOr404(id));
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
});

agentSessionLifecycleRoutes.post(
  '/:id/runner',
  zValidator('param', idParamSchema),
  zValidator('json', setRunnerBodySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const { session } = await ensureSessionOwnerOrAdmin(id, userId);

    if (session.status === 'running' || session.status === 'queued') {
      throw refuseSession(
        'SESSION_BUSY',
        'The agent is still working on this conversation. Wait for it to finish or stop it, then switch runner.',
      );
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

    const updated = await rebindSessionRunner(id, {
      deviceId: picked,
      metadata: nextMeta,
      repoPath,
    });
    if (!updated) throw notFound('agent session not found');

    broadcastSession(updated, 'agent-session.updated');
    return c.json(updated);
  },
);
