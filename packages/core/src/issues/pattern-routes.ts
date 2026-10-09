/**
 * An issue's patterns over REST (REQ-36 BC-2, BC-3; Issue lifecycle r14 `design-check`): list them,
 * name one (a catalogued slug is reuse and needs no approval; any other is new and waits on one
 * reviewer), decide a new one (a holder of patterns.approve, never the run or person that named it),
 * retract one. A box's runs share its credential, so a box call is the run holding the issue there,
 * or the one its `run` names (`pattern-runs.ts`).
 */

import {
  DECIDE_PATTERN_SHAPE,
  decidePatternRequestSchema,
  NAME_PATTERN_SHAPE,
  namePatternRequestSchema,
  RETRACT_PATTERN_SHAPE,
  retractPatternRequestSchema,
} from '@forge/contracts/patterns';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { notFound } from '../middleware/route-errors.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { resolveIssueRouteRef } from './issue-route-ref.js';
import {
  decidePattern,
  issuePatternsOf,
  namePattern,
  type PatternActor,
  patternRowsOf,
  patternViews,
  retractPattern,
} from './patterns.js';

type Ctx = Context<{ Variables: AuthVars }>;

/** The caller as the pattern rules read it: its account, its agency, and the box a box credential is. */
function actorOf(c: Ctx, run?: string): PatternActor {
  return {
    userId: c.get('userId'),
    agency: c.get('agency') ?? null,
    box: c.get('patDeviceId') ?? c.get('deviceId') ?? null,
    run,
  };
}

const issueParam = z.object({ id: z.string().min(1) });
const patternParam = z.object({ id: z.string().min(1), patternId: z.uuid() });
const scopeQuery = z.object({ projectId: z.uuid().optional() });

export const issuePatternRoutes = new Hono<{ Variables: AuthVars }>();
issuePatternRoutes.use('/:id/patterns', requireAuth(), assertEmailVerified());
issuePatternRoutes.use('/:id/patterns/*', requireAuth(), assertEmailVerified());

/** GET /api/issues/:id/patterns — every pattern the issue names, and whether a pending review holds it. */
issuePatternRoutes.get(
  '/:id/patterns',
  zValidator('param', issueParam),
  zValidator('query', scopeQuery),
  async (c) => {
    const issue = await resolveIssueRouteRef(
      c.req.valid('param').id,
      c.req.valid('query').projectId,
      c.get('userId'),
    );
    return c.json(await issuePatternsOf(issue.projectId, issue.id, actorOf(c)));
  },
);

/** POST /api/issues/:id/patterns — the issue builds to this pattern; a new one waits on its reviewer. */
issuePatternRoutes.post(
  '/:id/patterns',
  zValidator('param', issueParam),
  zValidator('query', scopeQuery),
  strictBody(namePatternRequestSchema, NAME_PATTERN_SHAPE),
  async (c) => {
    const userId = c.get('userId');
    const issue = await resolveIssueRouteRef(
      c.req.valid('param').id,
      c.req.valid('query').projectId,
      userId,
    );
    await requireCan(actorFor(userId), 'project.write', projectResource(issue.projectId));
    const body = c.req.valid('json');
    const out = await namePattern({
      issue: { id: issue.id, projectId: issue.projectId, status: issue.status },
      pattern: body.pattern,
      summary: body.summary ?? null,
      actor: actorOf(c, body.run),
    });
    if (!out.ok) return refused(c, out.refusals, 'PATTERN_REFUSED');
    const [pattern] = await patternViews([out.value], await patternRowsOf([issue.id]));
    return c.json({ pattern }, 201);
  },
);

/** POST /api/issues/:id/patterns/:patternId/decision — one reviewer approves or returns a new pattern. */
issuePatternRoutes.post(
  '/:id/patterns/:patternId/decision',
  zValidator('param', patternParam),
  zValidator('query', scopeQuery),
  strictBody(decidePatternRequestSchema, DECIDE_PATTERN_SHAPE),
  async (c) => {
    const userId = c.get('userId');
    const { id, patternId } = c.req.valid('param');
    const issue = await resolveIssueRouteRef(id, c.req.valid('query').projectId, userId);
    await requireCan(actorFor(userId), 'patterns.approve', projectResource(issue.projectId));
    const body = c.req.valid('json');
    const out = await decidePattern({
      issueId: issue.id,
      projectId: issue.projectId,
      patternId,
      decision: body.decision,
      reason: body.reason,
      actor: actorOf(c, body.run),
    });
    if (!out) throw notFound(`the issue names no pattern ${patternId}`);
    if (!out.ok) return refused(c, out.refusals, 'PATTERN_REFUSED');
    const [pattern] = await patternViews([out.value], await patternRowsOf([issue.id]));
    return c.json({ pattern });
  },
);

/** POST /api/issues/:id/patterns/:patternId/retract — the issue no longer takes this pattern; the row stays. */
issuePatternRoutes.post(
  '/:id/patterns/:patternId/retract',
  zValidator('param', patternParam),
  zValidator('query', scopeQuery),
  strictBody(retractPatternRequestSchema, RETRACT_PATTERN_SHAPE),
  async (c) => {
    const userId = c.get('userId');
    const { id, patternId } = c.req.valid('param');
    const issue = await resolveIssueRouteRef(id, c.req.valid('query').projectId, userId);
    await requireCan(actorFor(userId), 'project.write', projectResource(issue.projectId));
    const out = await retractPattern({
      issueId: issue.id,
      patternId,
      reason: c.req.valid('json').reason,
      userId,
    });
    if (!out) throw notFound(`the issue names no pattern ${patternId}`);
    if (!out.ok) return refused(c, out.refusals, 'PATTERN_REFUSED');
    const [pattern] = await patternViews([out.value], await patternRowsOf([issue.id]));
    return c.json({ pattern });
  },
);
