/**
 * ISS-102 — REST surface for pipeline_run lifecycle controls.
 *
 * Three POST endpoints (`/:id/pause`, `/:id/resume`, `/:id/cancel`) mounted
 * under `/api/pipeline-runs`. Auth-gated to project members + owner. The
 * actual transition semantics live in `./runs-control.ts` so the same code
 * path is shared with the matching `forge_pipeline_runs.*` MCP tools.
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { pipelineRuns } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  cancelPipelineRun,
  type PipelineRunRow,
  pausePipelineRun,
  resumePipelineRun,
} from './runs-control.js';

const idParamSchema = z.object({ id: z.uuid() });

// cm:edge contract -> packages/core/src/pipeline/runs-control.ts — omitting `parkIssue` must reach `cancelPipelineRun` as absent, not as `false`; the default lives there and sending `false` here silently flips every existing caller to the no-park intent
const cancelBodySchema = z.object({ parkIssue: z.boolean().optional() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const runConflict = (message: string) =>
  new HTTPException(409, { message, cause: { code: 'run_terminal' } });

async function loadRunWithAccess(runId: string, userId: string): Promise<PipelineRunRow> {
  const [row] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, runId)).limit(1);
  if (!row) throw notFound('pipeline run not found');
  // pause/resume/cancel are mutations — viewers are read-only.
  const access = await loadProjectAccess(row.projectId, userId);
  assertProjectRole(access, 'member');
  return row;
}

function rethrowControlError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('NOT_FOUND:')) {
    throw notFound(message.slice('NOT_FOUND: '.length) || 'pipeline run not found');
  }
  if (message.startsWith('CONFLICT:')) {
    throw runConflict(message.slice('CONFLICT: '.length) || 'run already terminal');
  }
  throw err;
}

export const pipelineRunRoutes = new Hono<{ Variables: AuthVars }>();
pipelineRunRoutes.use('*', requireAuth(), assertEmailVerified());

pipelineRunRoutes.post(
  '/:id/pause',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await loadRunWithAccess(id, userId);
    try {
      const run = await pausePipelineRun(id);
      return c.json(run);
    } catch (err) {
      rethrowControlError(err);
    }
  },
);

pipelineRunRoutes.post(
  '/:id/resume',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await loadRunWithAccess(id, userId);
    try {
      const run = await resumePipelineRun(id);
      return c.json(run);
    } catch (err) {
      rethrowControlError(err);
    }
  },
);

pipelineRunRoutes.post(
  '/:id/cancel',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await loadRunWithAccess(id, userId);
    const body = cancelBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw badRequest(z.flattenError(body.error));
    try {
      const result = await cancelPipelineRun(id, {
        actorUserId: userId,
        ...(body.data.parkIssue !== undefined ? { parkIssue: body.data.parkIssue } : {}),
      });
      return c.json(result);
    } catch (err) {
      rethrowControlError(err);
    }
  },
);
