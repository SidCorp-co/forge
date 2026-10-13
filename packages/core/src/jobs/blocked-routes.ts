import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { zValidator } from '../middleware/validator.js';
import { heldDecisionOf } from '../release-batch/decision-state.js';
import { BlockedJobMissing, endBlockedJob } from './blocked.js';
import { blockedBodySchema } from './blocked-wire.js';
import { readJobGate } from './job-queries.js';
import { OCCUPYING_JOB_STATUSES } from './status-sets.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const jobIdParamSchema = z.object({ id: z.uuid() });

export const jobBlockedRoutes = new Hono<{ Variables: DeviceVars }>();

/**
 * A box ends a job pane that stopped on a question, and says what the pane asked. It is the
 * failure route for that one ending: the job fails, nothing retries it, and the question is where a
 * person reads it. Sent again for a job already ended this way it answers what the first one did.
 */
jobBlockedRoutes.post(
  '/:id/blocked',
  requireDevice(),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', blockedBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const device = c.get('device');

    const job = await readJobGate(id);
    if (!job) {
      throw new HTTPException(404, { message: 'job not found', cause: { code: 'NOT_FOUND' } });
    }
    if (job.deviceId !== device.id) {
      throw new HTTPException(403, {
        message: 'job is not dispatched to this device',
        cause: { code: 'FORBIDDEN' },
      });
    }
    if (job.status === 'failed') {
      const prior = await heldDecisionOf(id);
      if (prior) {
        return c.json({
          jobId: id,
          status: 'failed',
          heldJobId: prior.heldJobId,
          questionIds: prior.questionIds,
          issueId: prior.issueId,
          replayed: true,
        });
      }
    }
    if (!OCCUPYING_JOB_STATUSES.includes(job.status)) {
      throw new HTTPException(409, {
        message: 'job is not in a runnable state',
        cause: { code: 'INVALID_STATE' },
      });
    }
    try {
      return c.json(await endBlockedJob(job, device.id, body));
    } catch (err) {
      if (err instanceof BlockedJobMissing) {
        throw new HTTPException(404, { message: 'job not found', cause: { code: 'NOT_FOUND' } });
      }
      throw err;
    }
  },
);
