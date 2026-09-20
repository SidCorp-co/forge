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
import { runnerLimitReasons } from '../db/schema.js';
import type { AnswerShape, QuestionBlockerKind, QuestionOption } from '../db/schema-questions.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { PARK_PROTECTIONS } from '../questions/protections.js';
import { answerOf, registerWaiter, waiterFor } from '../questions/read.js';
import { type AskAnswer, askQuestion, QuestionRefused } from '../questions/write.js';
import { assertDeviceBoundToProject } from './device-project.js';
import { badRequest, notFound, sessionParamsSchema } from './route-errors.js';

type AskBody = {
  id?: string;
  projectId?: string;
  issueId?: string;
  agentSessionId?: string;
  runId?: string;
  prompt?: string;
  blockerKind?: QuestionBlockerKind;
  answerShape?: AnswerShape;
  options?: QuestionOption[];
  recommendedOptionId?: string;
  needed?: string;
  assumed?: Record<string, unknown>;
  cost?: { claimsHeld?: number; workspacesPinned?: number; dependents?: number };
  sensitive?: boolean;
};

import { readDeviceIssueLease } from '../issues/issue-lease.js';
import { readAdmissibleIssues } from './admissible.js';
import {
  prepareJobForMaster,
  releaseAllHeldBySession,
  releaseJobFromMaster,
  startJobForMaster,
} from './claim.js';
import { readDeviceLoad, readFleetLoad, readProjectLoad } from './load.js';
import { clearMasterLimit, recordMasterLimit } from './master-limit.js';
import { closeMasterSession, ensureMasterSession } from './master-session.js';
import { readPool } from './pool.js';
import { readRunSessionTerminal, releaseIssueLease } from './run-session.js';
import { deviceRunSessionRoutes } from './run-session-routes.js';

export const devicePoolRoutes = new Hono<{ Variables: DeviceVars }>();

// The run-session family lives in its own module; it is mounted here so the paths it
// serves are unchanged and no caller can tell the two apart.
devicePoolRoutes.route('/', deviceRunSessionRoutes);

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
    return c.json({ items, count: items.length });
  },
);

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

const leaseParamsSchema = z.object({ issueKey: z.string().min(1).max(64) });

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
    // Two questions, both answered, because they are different ones: `held` is
    // the fleet-wide fact, `heldByThisDevice` is what a close loop asking
    // "have I given this back" means. Answering the second under the first
    // name is the defect ISS-1109 closed.
    return c.json(await readDeviceIssueLease({ deviceId: c.get('device').id, issueKey }));
  },
);

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

devicePoolRoutes.get('/me/protections', requireDevice(), async (c) =>
  c.json({ protections: PARK_PROTECTIONS }),
);

function askAnswerOf(body: AskBody): AskAnswer {
  if (body.answerShape === 'free_text') return { shape: 'free_text', needed: body.needed ?? '' };
  return {
    shape: 'choice',
    options: body.options ?? [],
    recommendedOptionId: body.recommendedOptionId ?? '',
  };
}

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
      answer: askAnswerOf(body),
    });
    if (body.runId) {
      await registerWaiter({ questionId: q.id, deviceId: c.get('device').id, runId: body.runId });
    }
    return c.json({ questionId: q.id });
  } catch (e) {
    if (e instanceof QuestionRefused) {
      throw new HTTPException(400, {
        message: e.message,
        cause: { code: e.code, details: e.message },
      });
    }
    throw e;
  }
});

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

const masterLimitSchema = z.object({
  reason: z.enum(runnerLimitReasons),
  resetsInSeconds: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60 * 60)
    .nullish(),
  detail: z.string().min(1).max(200),
});

devicePoolRoutes.post(
  '/me/limit',
  requireDevice(),
  zValidator('json', masterLimitSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const body = c.req.valid('json');
    const resetsInSeconds = body.resetsInSeconds ?? null;
    if (body.reason === 'auth' && resetsInSeconds !== null) {
      throw new HTTPException(400, {
        message: "an 'auth' limit has no reset — report it without `resetsInSeconds`",
        cause: { code: 'AUTH_LIMIT_HAS_NO_RESET' },
      });
    }
    const stamped = await recordMasterLimit(c.get('device').id, {
      reason: body.reason,
      resetsInSeconds,
      detail: body.detail,
    });
    if (!stamped) throw notFound('claude-code runner for this device');
    return c.json({ runnerId: stamped.runnerId });
  },
);

devicePoolRoutes.delete('/me/limit', requireDevice(), async (c) => {
  const cleared = await clearMasterLimit(c.get('device').id);
  if (!cleared) throw notFound('claude-code runner for this device');
  return c.json({ runnerId: cleared.runnerId });
});
