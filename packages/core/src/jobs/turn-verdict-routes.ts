import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { forbidden } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { AUTONOMOUS_QUESTION_STATUS } from '../pipeline/autonomous-mode.js';
import { issueStatusOf, jobDispatchOf } from './read.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });
const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const jobTurnVerdictRoutes = new Hono<{ Variables: DeviceVars }>();

const paramSchema = z.object({ id: z.uuid() });

jobTurnVerdictRoutes.get(
  '/:id/turn-verdict',
  requireDevice(),
  zValidator('param', paramSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const job = await jobDispatchOf(id);
    if (!job) throw notFound('job not found');
    if (job.deviceId !== c.get('device').id) {
      throw forbidden('job is not dispatched to this device');
    }

    if (!job.issueId) return c.json({ done: true });

    const issueStatus = await issueStatusOf(job.issueId);
    return c.json({ done: issueStatus !== AUTONOMOUS_QUESTION_STATUS });
  },
);
