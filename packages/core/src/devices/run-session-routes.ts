/**
 * The device-facing half of a RUN SESSION: open one, close it, and write the two
 * records a box owes about a run it could not finish cleanly.
 *
 * Split out of `pool-routes.ts`, which had grown four unrelated route families. These
 * four share one subject and one device scoping rule: a box speaks for its own run
 * sessions and nobody else's, so every one of them answers 404 rather than writing
 * against a session another box opened.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { IssueLeaseHeldError } from '../issues/issue-lease.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { badRequest, conflict, notFound, sessionParamsSchema } from './route-errors.js';
import {
  heldWorktreeSchema,
  resumeChoiceSchema,
  runCheckpointSchema,
  writeHeldWorktreeReport,
  writeResumeChoice,
  writeRunEvidence,
} from './run-evidence.js';
import { closeRunSession, openRunSession } from './run-session.js';

export const deviceRunSessionRoutes = new Hono<{ Variables: DeviceVars }>();

const runSessionBodySchema = z.object({
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  issueKeys: z.array(z.string().min(1)).min(1).max(16),
  name: z.string().min(1).max(60),
});

deviceRunSessionRoutes.post(
  '/me/run-sessions',
  requireDevice(),
  zValidator('json', runSessionBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const body = c.req.valid('json');
    try {
      const session = await openRunSession({
        deviceId: c.get('device').id,
        projectId: body.projectId,
        issueKeys: body.issueKeys,
        name: body.name,
        boxRunId: body.runId,
      });
      return c.json(session);
    } catch (err) {
      // The refusal IS the deliverable here: a box told only that the open
      // failed retries against the same holder until the lease lapses.
      if (err instanceof IssueLeaseHeldError) {
        throw conflict(err.code, err.message, { holders: err.holders });
      }
      throw err;
    }
  },
);

const closeBodySchema = z.object({
  outcome: z.enum(['ended', 'killed_idle', 'died']),
  detail: z.string().max(500).optional(),
  checkpoint: runCheckpointSchema.optional(),
});

deviceRunSessionRoutes.post(
  '/me/run-sessions/:sessionId/close',
  requireDevice(),
  zValidator('param', sessionParamsSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', closeBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { sessionId } = c.req.valid('param');
    const body = c.req.valid('json');
    if (body.checkpoint) {
      await writeRunEvidence({
        deviceId: c.get('device').id,
        sessionId,
        checkpoint: body.checkpoint,
      });
    }
    const closed = await closeRunSession({
      deviceId: c.get('device').id,
      sessionId,
      outcome: body.outcome,
      ...(body.detail === undefined ? {} : { detail: body.detail }),
    });
    if (closed === null) throw notFound('run session');
    return c.json(closed);
  },
);
deviceRunSessionRoutes.post(
  '/me/run-sessions/:sessionId/held-worktree',
  requireDevice(),
  zValidator('param', sessionParamsSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', heldWorktreeSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { sessionId } = c.req.valid('param');
    const reported = await writeHeldWorktreeReport({
      deviceId: c.get('device').id,
      sessionId,
      held: c.req.valid('json'),
    });
    if (reported === null) throw notFound('run session');
    return c.json(reported);
  },
);

deviceRunSessionRoutes.post(
  '/me/run-sessions/:sessionId/resume-choice',
  requireDevice(),
  zValidator('param', sessionParamsSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', resumeChoiceSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { sessionId } = c.req.valid('param');
    const written = await writeResumeChoice({
      deviceId: c.get('device').id,
      sessionId,
      choice: c.req.valid('json'),
    });
    if (written === null) throw notFound('run session');
    return c.json(written);
  },
);
