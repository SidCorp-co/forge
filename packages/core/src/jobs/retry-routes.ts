/**
 * A person retries a failed job (ISS-1229 r16). The project page's "Approve & retry" opened the issue
 * and did nothing else: no route let a person retry a job that failed for good. Mounted under
 * `/api/jobs` by `lifecycle-routes.ts`.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { declaresInput, zValidator } from '../api-reference/declare/validator.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { readJobGate } from './job-queries.js';
import {
  cancelBodySchema,
  jobIdParamSchema,
  readReasonBody,
  retriedSchema,
  retryJob,
} from './lifecycle-routes-reference.js';
import { JobRetryError, retryFailedJob } from './retry-failed-job.js';

export const jobRetryUserRoutes = new Hono<{ Variables: AuthVars }>();

jobRetryUserRoutes.post(
  '/:id/retry',
  requireAuth(),
  assertEmailVerified(),
  retryJob,
  declaresInput('json', cancelBodySchema),
  zValidator('param', jobIdParamSchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
    }
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const job = await readJobGate(id);
    if (!job)
      throw new HTTPException(404, { message: 'job not found', cause: { code: 'NOT_FOUND' } });
    const access = await loadProjectAccess(job.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    const { reason } = await readReasonBody(c.req);

    try {
      const result = await retryFailedJob(id, {
        actorUserId: userId,
        reason: reason ?? 'manual retry (REST)',
        source: 'rest',
      });
      return c.json(answer(retriedSchema, result));
    } catch (e) {
      if (!(e instanceof JobRetryError)) throw e;
      const status = e.code === 'NOT_FOUND' ? 404 : 409;
      throw new HTTPException(status, { message: e.message, cause: { code: e.code } });
    }
  },
);
