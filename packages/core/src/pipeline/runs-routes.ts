/**
 * ISS-102 — REST surface for pipeline_run lifecycle controls.
 *
 * Three POST endpoints (`/:id/pause`, `/:id/resume`, `/:id/cancel`) mounted
 * under `/api/pipeline-runs`. Auth-gated to project members + owner. The
 * actual transition semantics live in `./runs-control.ts`.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { badRequest, idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { readPipelineRun } from './runs.js';
import {
  cancelPipelineRun,
  type PipelineRunRow,
  pausePipelineRun,
  resumePipelineRun,
} from './runs-control.js';

const cancelBodySchema = z.object({ parkIssue: z.boolean().optional() });

async function loadRunWithAccess(runId: string, userId: string): Promise<PipelineRunRow> {
  const row = await readPipelineRun(runId);
  if (!row) throw notFound('pipeline run not found');
  const access = await loadProjectAccess(row.projectId, userId);
  requireHeld(access, 'project.write');
  return row;
}

function rethrowControlError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('NOT_FOUND:')) {
    throw notFound(message.slice('NOT_FOUND: '.length) || 'pipeline run not found');
  }
  throw err;
}

export const pipelineRunRoutes = new Hono<{ Variables: AuthVars }>();
pipelineRunRoutes.use('*', requireAuth(), assertEmailVerified());

pipelineRunRoutes.post(
  '/:id/pause',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await loadRunWithAccess(id, userId);
    try {
      const run = await pausePipelineRun(id, restActor(c));
      return c.json(run);
    } catch (err) {
      rethrowControlError(err);
    }
  },
);

pipelineRunRoutes.post(
  '/:id/resume',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await loadRunWithAccess(id, userId);
    try {
      const run = await resumePipelineRun(id, restActor(c));
      return c.json(run);
    } catch (err) {
      rethrowControlError(err);
    }
  },
);

pipelineRunRoutes.post(
  '/:id/cancel',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', cancelBodySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    await loadRunWithAccess(id, userId);
    const body = c.req.valid('json');
    try {
      const result = await cancelPipelineRun(id, {
        actorUserId: userId,
        actorAgency: restActor(c).agency,
        ...(body.parkIssue !== undefined ? { parkIssue: body.parkIssue } : {}),
      });
      return c.json(result);
    } catch (err) {
      rethrowControlError(err);
    }
  },
);
