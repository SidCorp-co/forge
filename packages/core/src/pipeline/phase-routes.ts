import { Hono } from 'hono';
import { z } from 'zod';
import { phaseJournalOutcomes } from '../db/schema-journal.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { endPhase, listPhases, resumePoint, startPhase } from './phase-journal.js';
import { refusePipeline } from './refuse.js';
import { readPipelineRun } from './runs.js';

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

async function runProjectFor(
  runId: string,
  userId: string,
  permission: 'project.read' | 'project.write',
) {
  const row = await readPipelineRun(runId);
  if (!row) throw notFound('pipeline run not found');
  const access = await loadProjectAccess(row.projectId, userId);
  requireHeld(access, permission);
  return row;
}

export const phaseRoutes = new Hono<{ Variables: AuthVars }>();
phaseRoutes.use('*', requireAuth(), assertEmailVerified());

phaseRoutes.post(
  '/:id/phases',
  zValidator('param', idParamSchema),
  zValidator('json', startBodySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const run = await runProjectFor(id, c.get('userId'), 'project.write');
    if (body.issueId && body.issueId !== run.issueId) {
      throw refusePipeline(
        'PHASE_REF_NOT_IN_RUN',
        `issue ${body.issueId} is not the issue of run ${id}`,
        '/issueId',
      );
    }
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
  zValidator('param', idParamSchema),
  zValidator('json', endBodySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    await runProjectFor(id, c.get('userId'), 'project.write');
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

phaseRoutes.get('/:id/resume-point', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  await runProjectFor(id, c.get('userId'), 'project.read');
  const row = await resumePoint(id);
  return c.json({
    resumePoint: row ? { phase: row.phase, attempt: row.attempt, startedAt: row.startedAt } : null,
  });
});

phaseRoutes.get('/:id/phases', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  await runProjectFor(id, c.get('userId'), 'project.read');
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
});
