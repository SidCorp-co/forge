import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issues, jobs } from '../db/schema.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { AUTONOMOUS_QUESTION_STATUS } from '../pipeline/autonomous-mode.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });
const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });
const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export const jobTurnVerdictRoutes = new Hono<{ Variables: DeviceVars }>();

const paramSchema = z.object({ id: z.uuid() });

jobTurnVerdictRoutes.get(
  '/:id/turn-verdict',
  requireDevice(),
  zValidator('param', paramSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const [job] = await db
      .select({ deviceId: jobs.deviceId, issueId: jobs.issueId })
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1);
    if (!job) throw notFound('job not found');
    if (job.deviceId !== c.get('device').id) {
      throw forbidden('job is not dispatched to this device');
    }

    if (!job.issueId) return c.json({ done: true });

    const [issue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, job.issueId))
      .limit(1);
    return c.json({ done: issue?.status !== AUTONOMOUS_QUESTION_STATUS });
  },
);
