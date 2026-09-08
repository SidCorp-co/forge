/**
 * The device-facing half of master orchestration: read the pool, take work,
 * give it back, and read load.
 *
 * Every route here is the device's own principal — the master reaches core
 * only through its daemon, so there is one holder of the device token.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { QuestionBlockerKind, QuestionOption } from '../db/schema-questions.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { PARK_PROTECTIONS } from '../questions/protections.js';
import { answerOf, registerWaiter, waiterFor } from '../questions/read.js';
import { askQuestion, QuestionRefused } from '../questions/write.js';
import { assertDeviceBoundToProject } from './device-project.js';

type AskBody = {
  id?: string;
  projectId?: string;
  issueId?: string;
  agentSessionId?: string;
  runId?: string;
  prompt?: string;
  blockerKind?: QuestionBlockerKind;
  options?: QuestionOption[];
  recommendedOptionId?: string;
  assumed?: Record<string, unknown>;
  cost?: { claimsHeld?: number; workspacesPinned?: number; dependents?: number };
};

import { readAdmissibleIssues } from './admissible.js';
import {
  prepareJobForMaster,
  releaseAllHeldBySession,
  releaseJobFromMaster,
  startJobForMaster,
} from './claim.js';
import { readDeviceLoad, readFleetLoad, readProjectLoad } from './load.js';
import { closeMasterSession, ensureMasterSession } from './master-session.js';
import { readPool } from './pool.js';
import {
  isIssueLeaseHeld,
  openRunSession,
  readRunSessionTerminal,
  releaseIssueLease,
} from './run-session.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (what: string) =>
  new HTTPException(404, { message: `${what} not found`, cause: { code: 'NOT_FOUND' } });

// cm:guard `requireDevice`, never `requireAnyAuth`. Only the latter sets `userId = device.ownerId`, which would hand a master session its owner's whole account authority; these routes must stay scoped to the device's own bindings so `loadProjectAccess` fails closed.
export const devicePoolRoutes = new Hono<{ Variables: DeviceVars }>();

const poolQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  projectId: z.string().uuid().optional(),
});

devicePoolRoutes.get(
  '/me/pool',
  requireDevice(),
  zValidator('query', poolQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { limit, projectId } = c.req.valid('query');
    const deviceId = c.get('device').id;
    const items = await readPool({ deviceId, projectId, limit });
    // cm:guard the pool is JOBS, and since ISS-933 it is jobs for the four kinds that have no issue to rank — `smoke`, `release_batch`, `reconcile`, `verify_skill`. `drive` reaches a box as a run session instead, so an issue never belongs in this array: a row with no `jobId` where a master claims from is a malformed claim waiting to happen.
    return c.json({ items, count: items.length });
  },
);

// cm:guard the issues a master may open a run session over, and the ONLY reader of `pipelineConfig.poolBacklog.statuses` after ISS-933 deleted `pool promote`. Without a live consumer that config key is configurable, savable and dead, which is the shape this repo refuses; a change that drops this route owes the key another reader or owes the key its deletion.
devicePoolRoutes.get(
  '/me/issues/admissible',
  requireDevice(),
  zValidator('query', poolQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const items = await readAdmissibleIssues({ deviceId: c.get('device').id, projectId });
    return c.json({ items, count: items.length });
  },
);

const runSessionBodySchema = z.object({
  projectId: z.string().uuid(),
  runId: z.string().uuid(),
  // cm:guard a LIST with a minimum of one, and no scalar sibling. A group of one takes the same path as a group of three, which is the whole of ISS-933 criterion 8 — a scalar entry point is how "one run, one issue" comes back, measured as two sessions in one worktree.
  issueKeys: z.array(z.string().min(1)).min(1).max(16),
  name: z.string().min(1).max(60),
});

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/run_sessions.rs — `open` posts this shape and reads `sessionId` back; the runner has already committed its ledger row by the time it calls, so a refusal here leaves a recorded run with no session, which its own close loop reads as "never started".
devicePoolRoutes.post(
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
    });
    return c.json(session);
  },
);

const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });
const leaseParamsSchema = z.object({ issueKey: z.string().min(1).max(64) });

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/recovery_ports.rs — `CoreRunState` reads these back; the close loop sets a mark ONLY from what they answer, never from the ack of the write it just made (ISS-933 criterion 13).
devicePoolRoutes.get(
  '/me/run-sessions/:sessionId',
  requireDevice(),
  zValidator('param', sessionParamsSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { sessionId } = c.req.valid('param');
    const terminal = await readRunSessionTerminal({ deviceId: c.get('device').id, sessionId });
    if (terminal === null) throw notFound('run session');
    return c.json({ sessionTerminal: terminal });
  },
);

devicePoolRoutes.get(
  '/me/issue-leases/:issueKey',
  requireDevice(),
  zValidator('param', leaseParamsSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { issueKey } = c.req.valid('param');
    return c.json({ held: await isIssueLeaseHeld({ deviceId: c.get('device').id, issueKey }) });
  },
);

// cm:guard answers 200 whether or not anything was held — the close loop retries every mark it still owes, so a second return of the same lease must be a no-op rather than a failure that parks the run.
devicePoolRoutes.delete(
  '/me/issue-leases/:issueKey',
  requireDevice(),
  zValidator('param', leaseParamsSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { issueKey } = c.req.valid('param');
    await releaseIssueLease({ deviceId: c.get('device').id, issueKey });
    return c.json({ ok: true });
  },
);

const claimBodySchema = z.object({
  jobId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

// cm:guard the old one-shot `/me/pool/claim` is GONE, and this refusal is what replaces it rather than a second live path. A runner that predates the ISS-919 split would receive a preparation and start nothing, parking claimable work on a master that never ran it; `runner_too_old` is a reason the master prints and an operator can act on, where silently composing prepare+start here would leave the box looking correct and the split unenforced.
devicePoolRoutes.post(
  '/me/pool/claim',
  requireDevice(),
  zValidator('json', claimBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => c.json({ ok: false, reason: 'runner_too_old' as const }),
);

/**
 * Take a job without starting it (ISS-919 B2).
 *
 * The job comes back `queued` and held, with its token and preparation. The
 * caller owes `/me/pool/start` or a release.
 */
devicePoolRoutes.post(
  '/me/pool/prepare',
  requireDevice(),
  zValidator('json', claimBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { jobId, sessionId } = c.req.valid('json');
    const result = await prepareJobForMaster({ jobId, deviceId: c.get('device').id, sessionId });
    // cm:guard a refused preparation answers 200 with `ok:false`, NOT 4xx. A busy issue and a lost race are ordinary outcomes a master handles by choosing differently; making them errors invites a retry loop against a condition retrying cannot change.
    return c.json(result);
  },
);

/** Hand a prepared job to the process now starting it. */
devicePoolRoutes.post(
  '/me/pool/start',
  requireDevice(),
  zValidator('json', claimBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { jobId, sessionId } = c.req.valid('json');
    const result = await startJobForMaster({ jobId, deviceId: c.get('device').id, sessionId });
    return c.json(result);
  },
);

const releaseBodySchema = z.object({
  jobId: z.string().uuid().optional(),
  sessionId: z.string().uuid(),
});

devicePoolRoutes.post(
  '/me/pool/release',
  requireDevice(),
  zValidator('json', releaseBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { jobId, sessionId } = c.req.valid('json');
    if (jobId) {
      const released = await releaseJobFromMaster({ jobId, sessionId });
      return c.json({ released: released ? 1 : 0 });
    }
    const released = await releaseAllHeldBySession(sessionId);
    return c.json({ released });
  },
);

const loadQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
});

devicePoolRoutes.get(
  '/me/load',
  requireDevice(),
  zValidator('query', loadQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const deviceId = c.get('device').id;
    const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);

    const device = await readDeviceLoad(deviceId);
    const project = projectId ? await readProjectLoad(projectId) : null;
    const fleet = projectId ? await readFleetLoad(projectId, livenessSeconds) : [];

    // cm:guard report raw counts and NEVER a recommendation field like `canTakeMore`. That number would be core deciding batch size again — the ceiling this design removed, wearing a helpful name — and a master reading it would stop weighing the facts that made it.
    return c.json({ device, project, fleet });
  },
);

const masterSessionBodySchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(120),
});

/**
 * Register (or re-find) this box's resident master for one project — B1's
 * bound, in the one place both halves can see it.
 */
devicePoolRoutes.post(
  '/me/master-session',
  requireDevice(),
  zValidator('json', masterSessionBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, name } = c.req.valid('json');
    const session = await ensureMasterSession({ deviceId: c.get('device').id, projectId, name });
    return c.json(session);
  },
);

const masterCloseBodySchema = z.object({
  sessionId: z.string().uuid(),
  reason: z.string().min(1).max(500),
});

/** The runner reporting a master it watched die (ISS-919 B3). */
// cm:guard closing the row and releasing the holds are TWO calls the runner makes in order, and this is deliberately only the first. `POST /me/pool/release` is the other, and it must be able to run for a session whose close already landed — a box that crashes between them leaves holds the three-minute reaper still collects, where one fused endpoint that failed halfway would leave neither half knowing which happened.
devicePoolRoutes.post(
  '/me/master-session/close',
  requireDevice(),
  zValidator('json', masterCloseBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { sessionId, reason } = c.req.valid('json');
    const closed = await closeMasterSession({ deviceId: c.get('device').id, sessionId, reason });
    return c.json({ closed });
  },
);

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/protections.rs — the box reads this BEFORE it releases a process, and requires every member of its own named set. An old core has no such route, so a 404 is a legitimate answer meaning "no protections" rather than a fault (ISS-964 criterion 27).
// cm:guard no project scope and no device state — this reports what THIS BUILD of core runs, which is what the box cannot otherwise know. Making it per-project would let a park be protected on one project and eaten on another by the same deployed code.
devicePoolRoutes.get('/me/protections', requireDevice(), async (c) =>
  c.json({ protections: PARK_PROTECTIONS }),
);

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/questions.rs — `ask` posts this shape and the box has already committed its own half; `id` is the join key and the runner mints it.
// cm:guard the box MINTS the question id and sends it; core never allocates one. The box has already written its own half of the park in a local transaction before this call, and a server-allocated id would make the two halves unjoinable across the window where the box has parked and core has not heard (ISS-964 criterion 10).
devicePoolRoutes.post('/me/questions', requireDevice(), async (c) => {
  const body = await c.req.json<AskBody>().catch(() => null);
  if (!body?.id || !body.projectId || !body.prompt) {
    throw badRequest('id, projectId and prompt are required');
  }
  await assertDeviceBoundToProject(c.get('device').id, body.projectId);
  try {
    const q = await askQuestion({
      ...body,
      id: body.id,
      projectId: body.projectId,
      prompt: body.prompt,
      blockerKind: body.blockerKind ?? 'human',
      options: body.options ?? [],
      recommendedOptionId: body.recommendedOptionId ?? '',
    });
    if (body.runId) {
      await registerWaiter({ questionId: q.id, deviceId: c.get('device').id, runId: body.runId });
    }
    return c.json({ questionId: q.id });
  } catch (e) {
    if (e instanceof QuestionRefused) throw badRequest(e.message);
    throw e;
  }
});

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/transport/questions.rs — `answer` reads this, and it distinguishes `answer: null` (not yet) from 404 (not this box's question); collapsing the two on either side turns somebody else's question into an eternal wait.
// cm:guard the box reads the ANSWER back rather than being sent it. A websocket that was down for the whole episode costs latency and nothing else, which is the only thing criterion 12 allows to be lost.
devicePoolRoutes.get('/me/questions/:questionId', requireDevice(), async (c) => {
  const questionId = c.req.param('questionId');
  const waiter = await waiterFor({
    questionId,
    deviceId: c.get('device').id,
    runId: c.req.query('runId') ?? '',
  });
  if (!waiter) throw notFound('question');
  return c.json({ answer: await answerOf(questionId) });
});
