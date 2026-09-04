// The memory-model flip as an operation (retrieval v3 phase 2, ISS-906):
// estimate, flip, status, cancel. A project admin's action, never a side
// effect of PUT /api/app-config — an hours-long paid job is not a boolean.

import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { appConfig, memoryModels } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import {
  countPending,
  enqueueChunkPurge,
  enqueueChunkReindex,
  estimateReindex,
  isLive,
  readReindex,
  writeReindex,
} from '../memory/chunk-reindex.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const paramSchema = z.object({ projectId: z.uuid() });
const flipSchema = z.object({ model: z.enum(memoryModels) }).strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const memoryModelRoutes = new Hono<{ Variables: AuthVars }>();
memoryModelRoutes.use('*', requireAuth(), assertEmailVerified());

const validParam = zValidator('param', paramSchema, (r) => {
  if (!r.success) throw badRequest(z.flattenError(r.error));
});

memoryModelRoutes.get('/:projectId/memory-model/estimate', validParam, async (c) => {
  const { projectId } = c.req.valid('param');
  const access = await loadProjectAccess(projectId, c.get('userId'));
  assertProjectRole(access, 'viewer', 'not a project member');
  return c.json(await estimateReindex(projectId));
});

memoryModelRoutes.get('/:projectId/memory-model/reindex', validParam, async (c) => {
  const { projectId } = c.req.valid('param');
  const access = await loadProjectAccess(projectId, c.get('userId'));
  assertProjectRole(access, 'viewer', 'not a project member');
  const [cfg] = await db
    .select({ model: appConfig.memoryModel })
    .from(appConfig)
    .where(eq(appConfig.projectId, projectId))
    .limit(1);
  return c.json({ model: cfg?.model ?? 'flat', reindex: await readReindex(projectId) });
});

// cm:guard 409 while a reindex is queued or running, and the state row is written BEFORE the job is sent — the job's first act is to read that state, so a job with no state exits, and two flips cannot both believe they own the run
memoryModelRoutes.post(
  '/:projectId/memory-model',
  validParam,
  zValidator('json', flipSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { model } = c.req.valid('json');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    assertProjectRole(access, 'admin', 'insufficient permission');

    const current = await readReindex(projectId);
    if (model === 'chunked') {
      if (isLive(current)) {
        throw new HTTPException(409, {
          message: 'a reindex is already queued or running',
          cause: { code: 'REINDEX_LIVE' },
        });
      }
      // cm:guard the queued state is sized by countPending, not the estimate — a resume after cancel/failure must show the rows already chunked as done, and the estimate counts every row as pending
      const counts = await countPending(projectId);
      const reindex = {
        state: 'queued' as const,
        total: counts.total,
        done: counts.total - counts.pending,
        remaining: counts.pending,
        requestedAt: new Date().toISOString(),
      };
      await db
        .insert(appConfig)
        .values({ projectId, memoryModel: 'chunked', memoryReindex: reindex })
        .onConflictDoUpdate({
          target: appConfig.projectId,
          set: { memoryModel: 'chunked', memoryReindex: reindex, updatedAt: sql`now()` },
        });
      await enqueueChunkReindex(projectId);
      return c.json({ model: 'chunked', reindex }, 202);
    }

    await db
      .insert(appConfig)
      .values({ projectId, memoryModel: 'flat' })
      .onConflictDoUpdate({
        target: appConfig.projectId,
        set: { memoryModel: 'flat', updatedAt: sql`now()` },
      });
    if (isLive(current)) {
      await writeReindex(projectId, { state: 'cancelled', finishedAt: new Date().toISOString() });
    }
    await enqueueChunkPurge(projectId);
    return c.json({ model: 'flat', reindex: await readReindex(projectId) });
  },
);

memoryModelRoutes.delete('/:projectId/memory-model/reindex', validParam, async (c) => {
  const { projectId } = c.req.valid('param');
  const access = await loadProjectAccess(projectId, c.get('userId'));
  assertProjectRole(access, 'admin', 'insufficient permission');
  const current = await readReindex(projectId);
  if (!isLive(current)) {
    throw new HTTPException(409, {
      message: 'no reindex is queued or running',
      cause: { code: 'REINDEX_NOT_LIVE' },
    });
  }
  await writeReindex(projectId, { state: 'cancelled', finishedAt: new Date().toISOString() });
  return c.json({ model: 'chunked', reindex: await readReindex(projectId) });
});
