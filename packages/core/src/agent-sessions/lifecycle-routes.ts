import { Hono } from 'hono';
import { type AuthVars, restActor } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { closeRunIfOneShot, refuseCancellingRelease } from '../pipeline/index.js';
import { broadcastSession } from './broadcast.js';
import { OWNER_OR_ADMIN } from './declarations.js';
import { agentSessionsPorts } from './ports.js';
import { pushSession } from './push.js';
import { refuseSession } from './refusals.js';
import { cancelSession } from './service.js';
import {
  ensureSessionOwnerOrAdmin,
  idParamSchema,
  loadSessionOr404,
  withTranscript,
} from './session-access.js';
import { boxOf } from './steer-turn.js';

export const agentSessionLifecycleRoutes = new Hono<{ Variables: AuthVars }>();

// ISS-1268: Stop writes the stream-json `interrupt` control request into the session's running
// turn on its box (`runner-agent/src/claude_code/control.rs`). The turn ends with its `result` and
// closes as every turn does, so the session keeps its process and the next message continues it.
// Nothing here kills a process or moves the session: the old `/abort`, which set it idle and had
// the box kill it, is gone.
agentSessionLifecycleRoutes.post(
  '/:id/interrupt',
  zValidator('param', idParamSchema),
  OWNER_OR_ADMIN,
  async (c) => {
    const { id } = c.req.valid('param');
    const { session } = await ensureSessionOwnerOrAdmin(id, c.get('userId'));
    if (session.status !== 'running') {
      throw refuseSession(
        'SESSION_NOT_RUNNING',
        `session ${id} is ${session.status}, so it has no turn to stop`,
      );
    }
    const deviceId = boxOf(session);
    const reached = deviceId
      ? agentSessionsPorts().sendToBoxNow(deviceId, {
          event: 'agent:interrupt',
          data: { sessionId: id },
        })
      : 0;
    if (reached === 0) {
      throw refuseSession(
        'NO_LIVE_SESSION',
        `session ${id}'s box ${deviceId ?? '(none recorded)'} is not connected, so its turn cannot be stopped from here`,
      );
    }
    return c.json({ ok: true, sessionId: id }, 202);
  },
);

// /cancel marks terminal as `failed` with reason='user_cancelled' (vs /:id/interrupt, which only
// stops the running turn). The sweeper then routes the linked job through recovery or escalation.
agentSessionLifecycleRoutes.post(
  '/:id/cancel',
  zValidator('param', idParamSchema),
  OWNER_OR_ADMIN,
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const { session } = await ensureSessionOwnerOrAdmin(id, userId);

    if (session.status === 'completed' || session.status === 'failed') {
      // Already terminal — return current state, idempotent.
      return c.json(await withTranscript(session));
    }

    // a release's session is ended by the release's abort, which records who and why (ISS-761)
    await refuseCancellingRelease(session.pipelineRunId, 'a session cancel');
    const updated = await cancelSession(id, restActor(c));
    if (!updated) {
      // CAS lost — return the current row so the client can re-render.
      return c.json(await withTranscript(await loadSessionOr404(id)));
    }

    // ISS-101 — close the one-shot run for cancelled interactive sessions.
    // No-op for kind='issue' (the issue state-machine owns those runs).
    await closeRunIfOneShot(updated.pipelineRunId, 'cancelled');

    // the box ends the session's process: a running turn is interrupted first, then its stdin closes
    const targetDeviceId = boxOf(updated);
    if (targetDeviceId) {
      await pushSession({
        projectId: null,
        deviceId: targetDeviceId,
        userIds: [],
        event: 'agent:close',
        data: { sessionId: updated.id, reason: 'user_cancelled' },
      });
    }

    broadcastSession(updated, 'agent-session.status', { failureReason: 'user_cancelled' });
    return c.json(await withTranscript(updated));
  },
);
