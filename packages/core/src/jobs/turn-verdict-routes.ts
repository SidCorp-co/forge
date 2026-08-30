// Whether a duplex turn ending is also the JOB ending.
//
// Under print the question could not be asked: one prompt was one process was
// one unit of work, so the process exiting WAS the job finishing. Under duplex
// a turn ends and the session is still alive, and the runner cannot tell which
// happened — the park is an issue-status move the driver made over MCP during
// the turn, so core holds the answer and the runner does not.
//
// So the runner asks, once per turn (ISS-873 phase 3). `lifecycle::complete`
// stays where it was; the print path is untouched.

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

    // cm:guard a job with no issue can never be parked on a question, so it is DONE — never "unknown". An answer this endpoint cannot give must still be an answer: a runner that reads a missing verdict as "stay resident" holds its slot forever on a job nobody can ever reply to.
    if (!job.issueId) return c.json({ done: true });

    const [issue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, job.issueId))
      .limit(1);
    // cm:guard a DELETED issue is done for the same reason — the park cannot be answered, so holding the session open only costs the slot.
    return c.json({ done: issue?.status !== AUTONOMOUS_QUESTION_STATUS });
  },
);
