import { OCCUPYING_JOB_STATUSES } from '@forge/contracts/job-machine';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { assertPlatformAdmin } from '../middleware/require-admin.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { forbidden } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { holds, requireHeld } from '../permissions/index.js';
import { cancelJob } from './cancel-job.js';
import { readJobGate } from './job-queries.js';
import { salvageSchema } from './prior-attempts.js';
import { refuseJob } from './refusals.js';
import { resumeHeldJob } from './resume-job.js';
import { failJobFromRunner } from './runner-finish.js';
import { ackJob, confirmJobKill } from './service.js';

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const jobIdParamSchema = z.object({ id: z.uuid() });

const ackBodySchema = z
  .object({
    skillsRanWith: z.record(z.string(), z.string().max(128)).optional(),
  })
  .passthrough();

const failBodySchema = z
  .object({ error: z.string().max(10_000), salvage: salvageSchema.optional() })
  .strict();

const cancelBodySchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();

const killAckBodySchema = z
  .object({
    outcome: z.enum(['killed', 'not_found']),
  })
  .strict();

async function loadJob(jobId: string) {
  const row = await readJobGate(jobId);
  if (!row) throw notFound('job not found');
  return row;
}

export const jobLifecycleDeviceRoutes = new Hono<{ Variables: DeviceVars }>();

// ISS-449 (ISS-442 C3 / I3) — explicit runner ACK for the dispatch→ack hop.
// The runner calls this right after its pre-claim preflight passes (ISS-451)
// and before spawning the agent; the first job_event batch doubles as a
// fallback ack for older runners (events-routes.ts). Idempotent: a repeat
// call (or a call racing the event fallback) keeps the first timestamp and
// reports `acked:false`. A terminal job is NOT an error — the runner treats
// ack as best-effort and must not abort the job over a late/lost ack.
jobLifecycleDeviceRoutes.post(
  '/:id/ack',
  requireDevice(),
  zValidator('param', jobIdParamSchema),
  zValidator('json', ackBodySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const device = c.get('device');

    const job = await loadJob(id);
    if (job.deviceId !== device.id) throw forbidden('job is not dispatched to this device');

    if (job.ackedAt) {
      return c.json({
        jobId: job.id,
        status: job.status,
        ackedAt: job.ackedAt.toISOString(),
        acked: false,
      });
    }

    const now = new Date();
    const updated = await ackJob(job, device.id, body.skillsRanWith ?? null, now);
    if (!updated) {
      const fresh = await loadJob(id);
      return c.json({
        jobId: fresh.id,
        status: fresh.status,
        ackedAt: fresh.ackedAt ? fresh.ackedAt.toISOString() : null,
        acked: false,
      });
    }
    return c.json({
      jobId: updated.id,
      status: updated.status,
      ackedAt: now.toISOString(),
      acked: true,
    });
  },
);

jobLifecycleDeviceRoutes.post(
  '/:id/fail',
  requireDevice(),
  zValidator('param', jobIdParamSchema),
  zValidator('json', failBodySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const device = c.get('device');

    const job = await loadJob(id);
    if (job.deviceId !== device.id) throw forbidden('job is not dispatched to this device');
    if (!OCCUPYING_JOB_STATUSES.includes(job.status)) {
      throw refuseJob('INVALID_STATE', 'job is not in a runnable state');
    }

    return c.json(await failJobFromRunner(job, input, device.id));
  },
);

/**
 * ISS-785 — device-scoped kill-ack for the `job.cancel` frame the
 * kill-before-reap gate sends. Deliberately NOT a lifecycle transition: it
 * only stamps `killConfirmedAt`/`killOutcome` (first ack wins — idempotent)
 * and appends a `kill_ack` audit event, then returns 200 whether or not the
 * job is still active. `resolveKillConfirmation` (jobs/kill-gate.ts) is the
 * ONLY reader of these columns. `recorded:false` in the response means the
 * ack was audited but not stamped — see the guard below.
 */
jobLifecycleDeviceRoutes.post(
  '/:id/kill-ack',
  requireDevice(),
  zValidator('param', jobIdParamSchema),
  zValidator('json', killAckBodySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { outcome } = c.req.valid('json');
    const device = c.get('device');

    const job = await loadJob(id);
    if (job.deviceId !== device.id) throw forbidden('job is not dispatched to this device');

    const recorded = job.killRequestedAt !== null;
    await confirmJobKill(id, outcome, device.id, recorded);

    return c.json({ jobId: id, killOutcome: outcome, acked: true, recorded });
  },
);

// Auth applied per-handler — see comment in jobs/routes.ts on why a bare
// `.use('*')` would 401 device-only sibling routes.
export const jobLifecycleUserRoutes = new Hono<{ Variables: AuthVars }>();

jobLifecycleUserRoutes.post(
  '/:id/cancel',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', jobIdParamSchema),
  zValidator('json', cancelBodySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const job = await loadJob(id);
    const access = await loadProjectAccess(job.projectId, userId);
    if (!holds(access, 'project.write')) await assertPlatformAdmin(c);

    const body = c.req.valid('json');

    const result = await cancelJob(id, {
      actorUserId: userId,
      actorAgency: restActor(c).agency,
      reason: body.reason ?? 'manual cancel (REST)',
      source: 'rest',
    });
    return c.json(result);
  },
);

jobLifecycleUserRoutes.post(
  '/:id/resume',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', jobIdParamSchema),
  zValidator('json', cancelBodySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    const job = await loadJob(id);
    requireHeld(await loadProjectAccess(job.projectId, userId), 'project.write');
    const result = await resumeHeldJob(id, {
      actorUserId: userId,
      actor: restActor(c),
      reason: c.req.valid('json').reason ?? 'manual resume (REST)',
      source: 'rest',
    });
    return c.json(result);
  },
);
