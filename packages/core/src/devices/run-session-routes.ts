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
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { badRequest, notFound, sessionParamsSchema } from './route-errors.js';
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
  // cm:guard a LIST with a minimum of one, and no scalar sibling. A group of one takes the same path as a group of three, which is the whole of ISS-933 criterion 8 — a scalar entry point is how "one run, one issue" comes back, measured as two sessions in one worktree.
  issueKeys: z.array(z.string().min(1)).min(1).max(16),
  name: z.string().min(1).max(60),
});

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/run_sessions.rs — `open` posts this shape and reads `sessionId` back; the runner has already committed its ledger row by the time it calls, so a refusal here leaves a recorded run with no session, which its own close loop reads as "never started".
deviceRunSessionRoutes.post(
  '/me/run-sessions',
  requireDevice(),
  zValidator('json', runSessionBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const body = c.req.valid('json');
    const session = await openRunSession({
      deviceId: c.get('device').id,
      projectId: body.projectId,
      issueKeys: body.issueKeys,
      name: body.name,
      // cm:guard the box's run id is PASSED ON rather than dropped. The schema has always
      // demanded it and the handler used to discard it, which is a 200 that does nothing with a
      // field the caller sent, and it left the box ledger and `pipeline_runs` with no key
      // between them (ISS-1050 criterion 6).
      boxRunId: body.runId,
    });
    return c.json(session);
  },
);

// cm:guard the outcome is a CLOSED set and an unknown one is refused, never coerced to a default. A box one version ahead sending a name this build does not know must be told so: coercing it to `died` would return issues an agent had deliberately advanced, and coercing it to `ended` would leave a dead run's issues held.
const closeBodySchema = z.object({
  outcome: z.enum(['ended', 'killed_idle', 'died']),
  detail: z.string().max(500).optional(),
  // cm:guard OPTIONAL, because a box one version behind sends no checkpoint and its close must
  // still work: the close is how a run session reaches terminal by being reported, and making the
  // evidence mandatory would turn every older box's close into a 400 and leave its issues held for
  // the reaper's ten minutes instead (ISS-1050).
  // cm:guard `.strict()` on the object and `source` REQUIRED. The payload declares what it is, and
  // a checkpoint that does not is refused by name rather than labelled by this end — printing an
  // undeclared payload under "reconstructed from the box" is the kernel vouching for something it
  // did not read.
  checkpoint: runCheckpointSchema.optional(),
});

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/run_sessions.rs — `close` is this route's only caller. It is what lets a run session reach terminal by being REPORTED rather than by going silent for ten minutes, which is the difference between a box that died, a pane that crashed and a pane that finished — three facts the reaper's one `runner_unreachable` could not tell apart.
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
    // cm:guard the evidence is written BEFORE the close and not after it, because the close is
    // allowed to answer `alreadyTerminal` — a box whose run core already reaped still has the only
    // copy of what that run left, and that is the case the evidence exists for. Both halves are
    // idempotent, so a retry of either order is a no-op; only this order writes the evidence for a
    // run core has given up on.
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
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/held_report.rs — the box
// posts this when it has refused to release a checkout because it could not establish that the work
// is on a remote. It is the half that moves that refusal off the box's journal and onto the issue:
// without it the box is holding a checkout for a reason only its own logs carry, which is a
// silence, and a silence is what this whole issue exists to end (ISS-1050 criterion 33).
// cm:guard REPORTS and moves nothing. The box refusing to release is already the strongest act
// available; a status change here would be the kernel deciding what happens to work whose owner it
// cannot ask.
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

// cm:guard the same device scoping as its two neighbours: a box may only speak for its own run
// sessions, so a report about another box's resumed master is a 404 rather than a comment.
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
