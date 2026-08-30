// `POST /api/jobs/:id/verdict` — the runner records the reviewer's result.
//
// This route exists because the driver may not author its own review record.
// The reviewer subagent returns a structured result to the RUNNER, and the
// runner posts it here under its device credential; the row lands with
// `source='runner'`, which is the one value the CHECK on `phase_journal`
// accepts for a verdict artifact.
//
// There is no user-authenticated twin. A verdict a human can post by hand is a
// verdict the agent can post through a human's token.
//
// Design: docs/proposals/agent-driven-pipeline.md

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { nextAttempt, recordVerdict, startPhase } from './phase-journal.js';
import { resolvePipelineWedge, reviewRoundsWedgeEntityId } from './wedge.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = () =>
  new HTTPException(404, { message: 'job not found', cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const paramSchema = z.object({ id: z.string().uuid() });

const bodySchema = z.object({
  phase: z.string().min(1).max(64).default('review'),
  attempt: z.number().int().positive().optional(),
  decision: z.enum(['approve', 'request_changes', 'abstain']),
  findings: z.array(z.unknown()).max(200).optional(),
});

export const verdictRoutes = new Hono<{ Variables: DeviceVars }>();

verdictRoutes.post(
  '/:id/verdict',
  requireDevice(),
  zValidator('param', paramSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', bodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const device = c.get('device');

    const [job] = await db
      .select({
        projectId: jobs.projectId,
        issueId: jobs.issueId,
        pipelineRunId: jobs.pipelineRunId,
        deviceId: jobs.deviceId,
        agentSessionId: jobs.agentSessionId,
      })
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1);
    if (!job) throw notFound();
    if (job.deviceId !== device.id) throw forbidden('job is not dispatched to this device');
    if (!job.pipelineRunId) throw badRequest('job has no pipeline run to record a verdict on');

    // cm:guard the row is OPENED here when the driver never declared the phase, rather than the update silently matching nothing — a verdict that updates zero rows would return 200 and leave no record, which is indistinguishable from a review that never ran
    let attempt = body.attempt;
    if (attempt === undefined) {
      const latest = await nextAttempt(job.pipelineRunId, body.phase);
      attempt = latest - 1;
      if (attempt < 1) {
        const opened = await startPhase({
          projectId: job.projectId,
          runId: job.pipelineRunId,
          phase: body.phase,
          issueId: job.issueId,
          jobId: id,
          agentSessionId: job.agentSessionId,
        });
        attempt = opened.attempt;
      }
    }

    await recordVerdict({
      runId: job.pipelineRunId,
      phase: body.phase,
      attempt,
      outcome: body.decision === 'request_changes' ? 'failed' : 'ok',
      verdict: {
        decision: body.decision,
        ...(body.findings ? { findings: body.findings } : {}),
      },
    });

    // cm:guard resolve on approve, and ONLY here — this route is the one place that observes the rejection streak `alarmRejectionStreaks` reports actually ending, and `wedge.ts` keys its dedupe on `resolvedAt IS NULL`, so an unresolved key leaves the bell red about a loop that has since landed
    // cm:edge lockstep -> packages/core/src/pipeline/inv7-alarms.ts — that pass is the only emitter under `reviewRoundsWedgeEntityId`; if it ever keys on something else (the job, the issue), this call must follow it
    if (body.decision === 'approve') {
      await resolvePipelineWedge(reviewRoundsWedgeEntityId(job.pipelineRunId));
    }

    return c.json({ jobId: id, phase: body.phase, attempt, decision: body.decision });
  },
);
