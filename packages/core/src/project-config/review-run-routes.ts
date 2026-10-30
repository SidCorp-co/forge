// `POST /api/projects/:id/review-runs`: a person holding project admin declares a review run over one
// issue on one box serving the project, so a session working for that person on the box reads the
// named testing profile at the one value door, under the box's credential, as a declared run does
// (`review-run-secrets.ts:resolveForReviewRun`). forge-core-61, 2026-10-30: before it, only the pane that
// is a project's master could declare a run, and a person's own session fell back to local files.

import { REVIEW_RUN_MAX_MINUTES } from '@forge/contracts/agent-sessions';
import { Hono } from 'hono';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { declareReviewRun } from './review-run.js';

export const reviewRunRoutes = new Hono<{ Variables: AuthVars }>();

const reviewRunBody = z.strictObject({
  /** The issue reviewed: its key (`ISS-12`, or a prefix the project answers to) or its id. */
  issue: z.string().trim().min(1).max(80),
  /** The box the reviewing session runs on: its device id or its name. */
  box: z.string().trim().min(1).max(120),
  /** The testing profile the run reads, by id. */
  profile: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  /** How long the run lives, in minutes. */
  minutes: z.number().int().min(1).max(REVIEW_RUN_MAX_MINUTES).optional(),
});

const REVIEW_RUN_SHAPE =
  '{ issue: <key or id>, box: <device id or name>, profile: <testing profile id>, minutes?: 1-120 }';

reviewRunRoutes.post(
  '/:id/review-runs',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', idParamSchema),
  strictBody(reviewRunBody, REVIEW_RUN_SHAPE),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await requireCan(
      actorFor(userId),
      'project.admin',
      projectResource(projectId),
      'Declaring a review run',
    );
    const declared = await declareReviewRun({
      projectId,
      userId,
      issue: body.issue,
      box: body.box,
      profile: body.profile,
      ...(body.minutes === undefined ? {} : { minutes: body.minutes }),
    });
    return c.json(declared, 201);
  },
);
