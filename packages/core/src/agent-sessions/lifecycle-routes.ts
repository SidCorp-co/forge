import { Hono } from 'hono';
import { type AuthVars, restActor } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { closeRunIfOneShot } from '../pipeline/index.js';
import { broadcastSession } from './broadcast.js';
import { abortBodySchema } from './lifecycle-schemas.js';
import { pushSession } from './push.js';
import { abortSession, cancelSession } from './service.js';
import {
  ensureSessionOwnerOrAdmin,
  idParamSchema,
  loadSessionOr404,
  withTranscript,
} from './session-access.js';

export const agentSessionLifecycleRoutes = new Hono<{ Variables: AuthVars }>();

agentSessionLifecycleRoutes.post('/abort', zValidator('json', abortBodySchema), async (c) => {
  const input = c.req.valid('json');
  const userId = c.get('userId');

  const { session } = await ensureSessionOwnerOrAdmin(input.sessionId, userId);

  const updated = await abortSession(input.sessionId, session.status, restActor(c));

  // Aborting a pipeline session just flips it to `idle`; the job failure path
  // retries, holds the job or closes the issue's open run, so there is no
  // separate hold flag to pin here.
  const meta = (updated.metadata ?? {}) as {
    type?: string;
    issueId?: string;
    deviceId?: string;
  };

  const targetDeviceId = meta.deviceId ?? updated.deviceId ?? null;
  if (targetDeviceId) {
    await pushSession({
      projectId: null,
      deviceId: targetDeviceId,
      userIds: [],
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
    return c.json(await withTranscript(session));
  }

  const updated = await cancelSession(id, restActor(c));
  if (!updated) {
    // CAS lost — return the current row so the client can re-render.
    return c.json(await withTranscript(await loadSessionOr404(id)));
  }

  // ISS-101 — close the one-shot run for cancelled interactive sessions.
  // No-op for kind='issue' (the issue state-machine owns those runs).
  await closeRunIfOneShot(updated.pipelineRunId, 'cancelled');

  const meta = (updated.metadata ?? {}) as { deviceId?: string };
  const targetDeviceId = meta.deviceId ?? updated.deviceId ?? null;
  if (targetDeviceId) {
    await pushSession({
      projectId: null,
      deviceId: targetDeviceId,
      userIds: [],
      event: 'agent:abort',
      data: { sessionId: updated.id, reason: 'user_cancelled' },
    });
  }

  broadcastSession(updated, 'agent-session.status', { failureReason: 'user_cancelled' });
  return c.json(await withTranscript(updated));
});
