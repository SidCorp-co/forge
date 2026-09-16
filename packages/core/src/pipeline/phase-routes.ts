/**
 * REST twin of the `forge_phase` MCP tool — mounted under `/api/pipeline-runs`.
 *
 * A phase declaration keys on `(run, phase, attempt)` and nothing about the
 * session that makes it: `issueId`, `jobId` and `agentSessionId` are optional
 * provenance the driver does not send. That is what makes it reachable from a
 * shell holding only a PAT, and it is why the data-plane doc used to park this
 * tool as MCP-only on the wrong rationale.
 *
 * Semantics live in `./phase-journal.ts`; this file is auth plus shape.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { phaseJournalOutcomes } from '../db/schema-journal.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { endPhase, listPhases, resumePoint, startPhase } from './phase-journal.js';
import { readPipelineRun } from './runs.js';

const idParamSchema = z.object({ id: z.uuid() });

const startBodySchema = z
  .object({
    phase: z.string().min(1).max(64),
    issueId: z.uuid().optional(),
    jobId: z.uuid().optional(),
    agentSessionId: z.uuid().optional(),
  })
  .strict();

const endBodySchema = z
  .object({
    phase: z.string().min(1).max(64),
    attempt: z.number().int().positive(),
    outcome: z.enum(phaseJournalOutcomes),
    note: z.string().max(4000).optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

async function runProjectFor(runId: string, userId: string, role: 'viewer' | 'member') {
  const row = await readPipelineRun(runId);
  if (!row) throw notFound('pipeline run not found');
  const access = await loadProjectAccess(row.projectId, userId);
  assertProjectRole(access, role);
  return row;
}

export const phaseRoutes = new Hono<{ Variables: AuthVars }>();
phaseRoutes.use('*', requireAuth(), assertEmailVerified());

phaseRoutes.post(
  '/:id/phases',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', startBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const run = await runProjectFor(id, c.get('userId'), 'member');
    const row = await startPhase({
      projectId: run.projectId,
      runId: id,
      phase: body.phase,
      issueId: body.issueId ?? run.issueId ?? null,
      jobId: body.jobId ?? null,
      agentSessionId: body.agentSessionId ?? null,
    });
    return c.json({ phase: row.phase, attempt: row.attempt, startedAt: row.startedAt }, 201);
  },
);

phaseRoutes.post(
  '/:id/phases/end',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', endBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    await runProjectFor(id, c.get('userId'), 'member');
    await endPhase({
      runId: id,
      phase: body.phase,
      attempt: body.attempt,
      outcome: body.outcome,
      ...(body.note ? { artifact: { kind: 'note' as const, text: body.note } } : {}),
    });
    return c.json({ phase: body.phase, attempt: body.attempt, outcome: body.outcome });
  },
);

phaseRoutes.get(
  '/:id/resume-point',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    await runProjectFor(id, c.get('userId'), 'viewer');
    const row = await resumePoint(id);
    return c.json({
      resumePoint: row
        ? { phase: row.phase, attempt: row.attempt, startedAt: row.startedAt }
        : null,
    });
  },
);

phaseRoutes.get(
  '/:id/phases',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    await runProjectFor(id, c.get('userId'), 'viewer');
    const rows = await listPhases(id);
    return c.json({
      phases: rows.map((row) => ({
        phase: row.phase,
        attempt: row.attempt,
        source: row.source,
        outcome: row.outcome,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        artifact: row.artifact,
      })),
    });
  },
);
