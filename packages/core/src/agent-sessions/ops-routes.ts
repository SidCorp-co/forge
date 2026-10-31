import { isDispatchStalled, type QueueStats } from '@forge/contracts/agent-sessions';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { onlineRunnerCount, sessionQueueDepth, sessionsWaiting } from './read.js';

/** Operator reads and triggers over a project's sessions; mounted under `agentSessionRoutes`, which authenticates. */
export const agentSessionOpsRoutes = new Hono<{ Variables: AuthVars }>();

// Queue depth per device — backs the worker panel + session placeholder.
const queueStatsQuerySchema = z
  .object({
    projectId: z.uuid(),
  })
  .strict();

agentSessionOpsRoutes.get('/queue-stats', zValidator('query', queueStatsQuerySchema), async (c) => {
  const { projectId } = c.req.valid('query');
  const userId = c.get('userId');

  const access = await loadProjectAccess(projectId, userId);
  requireHeld(access, 'project.read');

  // Group counts by deviceId × status. Devices without any active session
  // simply don't appear; the UI lists those via the standard devices API.
  const [rows, waiting, onlineRunners] = await Promise.all([
    sessionQueueDepth(projectId),
    sessionsWaiting(projectId),
    onlineRunnerCount(projectId),
  ]);

  type Bucket = { deviceId: string | null; queued: number; running: number };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const key = r.deviceId ?? '__null__';
    const b = buckets.get(key) ?? { deviceId: r.deviceId, queued: 0, running: 0 };
    if (r.status === 'queued') b.queued = Number(r.count);
    if (r.status === 'running') b.running = Number(r.count);
    buckets.set(key, b);
  }
  const stats: QueueStats = {
    devices: Array.from(buckets.values()),
    waiting,
    onlineRunners,
    dispatchStalled: isDispatchStalled(waiting, onlineRunners),
  };
  return c.json(stats);
});

// Manual sweep trigger — flush zombies without waiting for the cron tick.
const sweepQuerySchema = z
  .object({
    projectId: z.uuid(),
  })
  .strict();

agentSessionOpsRoutes.post('/sweep-zombies', zValidator('query', sweepQuerySchema), async (c) => {
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
