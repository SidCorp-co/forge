/**
 * `GET /api/me/pulse` — the workspace dashboard's one read.
 *
 * The surface it feeds asks five questions in order: is the control plane
 * executing, where is the work piling up, what needs a person, which way is the
 * flow going, does the output hold. None of them had an organization-scoped
 * answer: `/api/projects/:id/pipeline-runs` is fenced to one project and the
 * cross-tenant rollups in `admin/` are behind `requireAdmin()`, so a client
 * would have had to fan out over every project it can see.
 */

import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { loadVisibleProjectIds } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { readPulseFlow } from './pulse-flow.js';
import { emptyBuckets } from './pulse-folds.js';
import { readPulseLiveness } from './pulse-liveness.js';
import { readPulseQuality } from './pulse-quality.js';
import { PULSE_THRESHOLDS, type PulseResponse, type PulseWork } from './pulse-types.js';
import { readPulseWork } from './pulse-work.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const pulseQuerySchema = z.object({ orgId: z.uuid().optional() });

const emptyWork = (): PulseWork => ({
  buckets: emptyBuckets(),
  abandoned: { total: 0, shown: [] },
  releaseWaiting: { total: 0, shown: [] },
  silentProjects: { total: 0, shown: [] },
  neverRanProjects: { total: 0, shown: [] },
  humanBlockedAges: [],
  perProject: [],
});

function emptyPulse(now: Date): PulseResponse {
  return {
    generatedAt: now.toISOString(),
    thresholds: PULSE_THRESHOLDS,
    liveness: {
      jobsRunning: 0,
      jobsQueued: 0,
      jobsHeld: 0,
      liveJobs: { total: 0, shown: [] },
      stuckRuns: { total: 0, shown: [] },
      lastJobAt: null,
      silenceSeconds: null,
      heartbeat: [],
      devices: { online: 0, draining: 0, total: 0 },
    },
    work: emptyWork(),
    flow: [],
    quality: {
      finished: { merged: 0, closedUnmerged: 0, dropped: 0 },
      reopened: { issues: 0, events: 0 },
      rework: { fix: 0, code: 0 },
      runFailure: {
        pipeline: { failed: 0, total: 0 },
        scheduler: { failed: 0, total: 0 },
        other: { failed: 0, total: 0 },
      },
      sessionFailures: [],
      pipelineFlow: [],
    },
  };
}

export const mePulseRoutes = new Hono<{ Variables: AuthVars }>();
mePulseRoutes.use('/pulse', requireAuth(), assertEmailVerified());

// cm:edge contract -> packages/core/src/auth/pat-permissions.ts — `/api/me` belongs to no PAT permission and must not gain one: this route fans out over every project the caller can see, so a token bound to one project would read another's jobs, runs and issue titles through it. The same reason `/api/me/ops-health` states.
mePulseRoutes.get(
  '/pulse',
  zValidator('query', pulseQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('query');
    const now = new Date();

    const visibleIds = await loadVisibleProjectIds(c.get('userId'));
    if (visibleIds.length === 0) return c.json(emptyPulse(now));

    const projectIds = orgId
      ? (
          await db
            .select({ id: projects.id })
            .from(projects)
            .where(and(inArray(projects.id, visibleIds), eq(projects.orgId, orgId)))
        ).map((r) => r.id)
      : visibleIds;

    if (projectIds.length === 0) return c.json(emptyPulse(now));

    const [liveness, work, flow, quality] = await Promise.all([
      readPulseLiveness(projectIds, PULSE_THRESHOLDS, now),
      readPulseWork(projectIds, PULSE_THRESHOLDS, now),
      readPulseFlow(projectIds, now),
      readPulseQuality(projectIds),
    ]);

    const response: PulseResponse = {
      generatedAt: now.toISOString(),
      thresholds: PULSE_THRESHOLDS,
      liveness,
      work,
      flow,
      quality,
    };
    return c.json(response);
  },
);
