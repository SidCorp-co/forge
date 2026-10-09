/**
 * An issue's timed checks over REST (REQ-36 BC-14; Issue to release r20 `act-build`; ISS-474): record
 * the checks a run made with their kind and duration, and read the time spent on each kind. A box's
 * call is the run holding the issue there, or the one its `run` names (`check-runs.ts`).
 */

import { RECORD_CHECKS_SHAPE, recordChecksRequestSchema } from '@forge/contracts/check-runs';
import { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { issueChecksOf, recordChecks } from './check-runs.js';
import { heldIssue, resolveIssueRouteRef } from './issue-route-ref.js';

const issueParam = z.object({ id: z.string().trim().min(1).max(200) });
const scopeQuery = z.object({ projectId: z.uuid().optional() });

export const issueCheckRunRoutes = new Hono<{ Variables: AuthVars }>();
issueCheckRunRoutes.use('/:id/checks', requireAuth(), assertEmailVerified());

/** GET /api/issues/:id/checks — every check recorded on the issue, and the time spent on each kind. */
issueCheckRunRoutes.get(
  '/:id/checks',
  zValidator('param', issueParam),
  zValidator('query', scopeQuery),
  async (c) => {
    const issue = await resolveIssueRouteRef(
      c.req.valid('param').id,
      c.req.valid('query').projectId,
      c.get('userId'),
    );
    return c.json(await issueChecksOf(issue.id));
  },
);

/** POST /api/issues/:id/checks — the checks a run timed, each recorded once on the run it came from. */
issueCheckRunRoutes.post(
  '/:id/checks',
  zValidator('param', idParamSchema),
  strictBody(recordChecksRequestSchema, RECORD_CHECKS_SHAPE),
  async (c) => {
    const issue = await heldIssue(c.req.valid('param').id, c.get('userId'), 'project.write');
    const body = c.req.valid('json');
    const actor = restActor(c);
    const out = await recordChecks({
      issue: { id: issue.id, projectId: issue.projectId },
      head: body.head,
      checks: body.checks,
      run: body.run,
      box: c.get('patDeviceId') ?? c.get('deviceId') ?? null,
      actor: { type: actor.type, id: actor.id, agency: actor.agency },
    });
    if (!out.ok) return refused(c, out.refusals, 'CHECK_RUNS_REFUSED');
    return c.json(out.value, out.value.recorded > 0 ? 201 : 200);
  },
);
