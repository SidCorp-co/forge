/**
 * The device-facing half of a RUN SESSION: open one, close it, and write the two
 * records a box owes about a run it could not finish cleanly.
 *
 * Split out of `pool-routes.ts`, which had grown four unrelated route families. These
 * four share one subject and one device scoping rule: a box speaks for its own run
 * sessions and nobody else's, so every one of them answers 404 rather than writing
 * against a session another box opened.
 */

import {
  RUN_VERDICT_SHAPE,
  type RunVerdict,
  runVerdictRequestSchema,
} from '@forge/contracts/run-verdict';
import { Hono } from 'hono';
import { z } from 'zod';
import { readRunIssues } from '../issues/index.js';
import { isRefusal, RefusalError } from '../lib/refusal.js';
import { utf16String } from '../lib/utf16-string.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { strictBody, zValidator } from '../middleware/zod-validator.js';
import { gateConditionSchema } from './gate-report.js';
import { notFound, sessionParamsSchema } from './route-errors.js';
import {
  heldWorktreeSchema,
  resumeChoiceSchema,
  runCheckpointSchema,
  writeHeldWorktreeReport,
  writeResumeChoice,
  writeRunEvidence,
} from './run-evidence.js';
import { closeRunSession, openRunSession, preflightRunSession } from './run-session.js';
import { runVerdict } from './run-verdict.js';

export const deviceRunSessionRoutes = new Hono<{ Variables: DeviceVars }>();

const runSessionBodySchema = z.object({
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  issueKeys: z.array(z.string().min(1)).min(1).max(16),
  name: utf16String(60).min(1),
  // Validated here rather than absorbed: a run is kernel, and a gate condition
  // this route cannot read is a contract break the box is told about by name
  // rather than a field quietly dropped. The heartbeat is the other way round,
  // and for its own stated reason (ISS-1192).
  gate: gateConditionSchema.optional(),
});

deviceRunSessionRoutes.post(
  '/me/run-sessions',
  requireDevice(),
  zValidator('json', runSessionBodySchema),
  async (c) => {
    const body = c.req.valid('json');
    try {
      const session = await openRunSession({
        deviceId: c.get('device').id,
        projectId: body.projectId,
        issueKeys: body.issueKeys,
        name: body.name,
        boxRunId: body.runId,
        ...(body.gate ? { gate: body.gate } : {}),
      });
      return c.json(session);
    } catch (err) {
      // The refusal IS the deliverable here: a box told only that the open
      // failed retries against the same holder until the lease lapses.
      if (isRefusal(err, 'WORKFLOW_DESIGN_NOT_APPROVED')) {
        throw new RefusalError(
          err.refusals.map(({ code, detail }) => ({ code, path: '/issueKeys', detail })),
          'RUN_SESSION_REFUSED',
        );
      }
      throw err;
    }
  },
);

const preflightBodySchema = z.object({
  projectId: z.string().uuid(),
  issueKeys: z.array(z.string().min(1)).min(1).max(16),
});

/**
 * Would a run over these issues be opened? Answered by the function the open calls, writing
 * nothing: the box asks it when a master declares, so a dispatch on a blocked issue is refused to
 * the master by name instead of to a sweep that cannot tell anyone.
 */
deviceRunSessionRoutes.post(
  '/me/run-sessions/preflight',
  requireDevice(),
  zValidator('json', preflightBodySchema),
  async (c) => {
    const body = c.req.valid('json');
    await preflightRunSession({ projectId: body.projectId, issueKeys: body.issueKeys });
    return c.json({ ok: true as const });
  },
);

const closeBodySchema = z.object({
  outcome: z.enum(['ended', 'killed_idle', 'died']),
  detail: utf16String(500).optional(),
  checkpoint: runCheckpointSchema.optional(),
});

deviceRunSessionRoutes.post(
  '/me/run-sessions/:sessionId/close',
  requireDevice(),
  zValidator('param', sessionParamsSchema),
  zValidator('json', closeBodySchema),
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
  zValidator('param', sessionParamsSchema),
  zValidator('json', heldWorktreeSchema),
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
  zValidator('param', sessionParamsSchema),
  zValidator('json', resumeChoiceSchema),
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

/**
 * Core's verdict on one run the box ledger still holds open (ADR 0009, What core takes over: Recovery
 * verdict). The box sends the facts only it can read; core reads the run's issues itself, within the
 * projects this box reaches, and answers keep, exit, close or settle.
 */
deviceRunSessionRoutes.post(
  '/me/run-sessions/verdict',
  requireDevice(),
  strictBody(runVerdictRequestSchema, RUN_VERDICT_SHAPE),
  async (c) => {
    const { projectId, facts } = c.req.valid('json');
    const issues =
      facts.process === 'none' && facts.issueKeys.length > 0
        ? await readRunIssues({
            deviceId: c.get('device').id,
            projectId,
            issueKeys: facts.issueKeys,
          })
        : { over: [], rests: [] };
    return c.json(runVerdict(facts, issues) satisfies RunVerdict);
  },
);
