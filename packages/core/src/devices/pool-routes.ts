/**
 * The device-facing half of master orchestration: read the pool, take work,
 * give it back, and read load.
 *
 * Every route here is the device's own principal — the master reaches core
 * only through its daemon, so there is one holder of the device token.
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { declaresInput, takesBodyAsSent, zValidator } from '../api-reference/declare/validator.js';
import type { AnswerShape, QuestionBlockerKind, QuestionOption } from '../db/schema-questions.js';
import {
  type ResolvedLeaseKey,
  readDeviceIssueLease,
  resolveLeaseKey,
} from '../issues/issue-lease.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { PARK_PROTECTIONS } from '../questions/protections.js';
import { answerOf, registerWaiter, waiterFor } from '../questions/read.js';
import { type AskAnswer, type AskInput, askQuestion, QuestionRefused } from '../questions/write.js';
import { readAdmissibleIssues } from './admissible.js';
import {
  prepareJobForMaster,
  releaseAllHeldBySession,
  releaseJobFromMaster,
  startJobForMaster,
} from './claim.js';
import { assertDeviceBoundToProject } from './device-project.js';
import { readDeviceLoad, readFleetLoad, readProjectLoad } from './load.js';
import { clearMasterLimit, recordMasterLimit } from './master-limit.js';
import { closeMasterSession, ensureMasterSession } from './master-session.js';
import { readPool } from './pool.js';
import {
  admissibleSchema,
  askQuestionBodySchema,
  askQuestionRoute,
  claimBodySchema,
  clearMasterLimitRoute,
  closeMasterSessionRoute,
  giveIssueLeaseBack,
  issueLeaseSchema,
  leaseGivenBackSchema,
  leaseParamsSchema,
  leaseQuerySchema,
  limitStampedSchema,
  listProtections,
  loadQuerySchema,
  loadSchema,
  masterCloseBodySchema,
  masterClosedSchema,
  masterLimitSchema,
  masterSessionBodySchema,
  masterSessionSchema,
  poolQuerySchema,
  poolSchema,
  prepareJob,
  prepareResultSchema,
  protectionsSchema,
  questionAnswerSchema,
  questionAskedSchema,
  questionParamSchema,
  questionQuerySchema,
  readAdmissible,
  readIssueLease,
  readLoad,
  readPoolRoute,
  readQuestionAnswer,
  readRunSessionTerminalRoute,
  registerMasterSession,
  releaseBodySchema,
  releasedSchema,
  releaseJob,
  reportMasterLimit,
  runSessionTerminalSchema,
  startJob,
  startResultSchema,
} from './pool-routes-reference.js';
import { badRequest, conflict, notFound, sessionParamsSchema } from './route-errors.js';
import { readRunSessionTerminal, releaseIssueLease } from './run-session.js';
import { deviceRunSessionRoutes } from './run-session-routes.js';

export const devicePoolRoutes = new Hono<{ Variables: DeviceVars }>();

// The run-session family lives in its own module; it is mounted here so the paths it
// serves are unchanged and no caller can tell the two apart.
devicePoolRoutes.route('/', deviceRunSessionRoutes);

devicePoolRoutes.get(
  '/me/pool',
  requireDevice(),
  readPoolRoute,
  zValidator('query', poolQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { limit, projectId } = c.req.valid('query');
    const deviceId = c.get('device').id;
    const items = await readPool({ deviceId, projectId, limit });
    return c.json(answer(poolSchema, { items, count: items.length }));
  },
);

devicePoolRoutes.get(
  '/me/issues/admissible',
  requireDevice(),
  readAdmissible,
  zValidator('query', poolQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const items = await readAdmissibleIssues({ deviceId: c.get('device').id, projectId });
    return c.json(answer(admissibleSchema, { items, count: items.length }));
  },
);

/**
 * The lease this request is about, or the refusal that says why there is none.
 *
 * Both endpoints go through it, because the pool hands a box the project's own
 * prefixed key while the store keeps the canonical one, and an endpoint that
 * skips the mapping answers about a lease that does not exist (ISS-1139).
 */
async function leaseKeyOf(rawKey: string, projectId?: string): Promise<ResolvedLeaseKey> {
  const resolved = await resolveLeaseKey({ rawKey, projectId: projectId ?? null });
  if (resolved.ok) return resolved.key;
  const { status, code, message } = resolved.refusal;
  throw new HTTPException(status, { message, cause: { code } });
}

devicePoolRoutes.get(
  '/me/run-sessions/:sessionId',
  requireDevice(),
  readRunSessionTerminalRoute,
  zValidator('param', sessionParamsSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { sessionId } = c.req.valid('param');
    const terminal = await readRunSessionTerminal({ deviceId: c.get('device').id, sessionId });
    if (terminal === null) throw notFound('run session');
    return c.json(answer(runSessionTerminalSchema, { sessionTerminal: terminal }));
  },
);

devicePoolRoutes.get(
  '/me/issue-leases/:issueKey',
  requireDevice(),
  readIssueLease,
  zValidator('param', leaseParamsSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', leaseQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const key = await leaseKeyOf(c.req.valid('param').issueKey, c.req.valid('query').projectId);
    // Two questions, both answered, because they are different ones: `held` is
    // the fleet-wide fact, `heldByThisDevice` is what a close loop asking
    // "have I given this back" means. Answering the second under the first
    // name is the defect ISS-1109 closed.
    return c.json(
      answer(
        issueLeaseSchema,
        await readDeviceIssueLease({
          deviceId: c.get('device').id,
          issueKey: key.issueKey,
          projectId: key.projectId,
        }),
      ),
    );
  },
);

devicePoolRoutes.delete(
  '/me/issue-leases/:issueKey',
  requireDevice(),
  giveIssueLeaseBack,
  zValidator('param', leaseParamsSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', leaseQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const rawKey = c.req.valid('param').issueKey;
    const key = await leaseKeyOf(rawKey, c.req.valid('query').projectId);
    const outcome = await releaseIssueLease({
      deviceId: c.get('device').id,
      issueKey: key.issueKey,
      projectId: key.projectId,
    });
    if (outcome.released) {
      return c.json(
        answer(leaseGivenBackSchema, {
          ok: true,
          issueKey: key.issueKey,
          projectId: outcome.projectId,
        }),
      );
    }
    // A delete that matched nothing is not a success: the box reads the ack as
    // the issue handed back and stops watching it (ISS-1139).
    if (outcome.reason === 'ambiguous') {
      throw conflict(
        'ISSUE_LEASE_AMBIGUOUS',
        [
          `this box holds ${outcome.projectIds.length} leases on ${key.issueKey}, one per project, and nothing was given back.`,
          ...outcome.projectIds.map((id) => `  ${key.issueKey} in project ${id}`),
          "A lease is given back for the project it was taken for, so name one: send `?projectId=<id>`, or that project's own issue prefix in the key.",
        ].join('\n'),
        { issueKey: key.issueKey, projectIds: outcome.projectIds },
      );
    }
    throw new HTTPException(404, {
      message: `no lease on ${key.issueKey}${key.projectId ? ` in project ${key.projectId}` : ''} is held by this box, so nothing was given back. \`${rawKey}\` resolved to the canonical \`${key.issueKey}\`, which is the form the lease store keeps.`,
      cause: { code: 'ISSUE_LEASE_NOT_HELD', details: { issueKey: key.issueKey } },
    });
  },
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
  prepareJob,
  zValidator('json', claimBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { jobId, sessionId } = c.req.valid('json');
    const result = await prepareJobForMaster({ jobId, deviceId: c.get('device').id, sessionId });
    return c.json(answer(prepareResultSchema, result));
  },
);

/** Hand a prepared job to the process now starting it. */
devicePoolRoutes.post(
  '/me/pool/start',
  requireDevice(),
  startJob,
  zValidator('json', claimBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { jobId, sessionId } = c.req.valid('json');
    const result = await startJobForMaster({ jobId, deviceId: c.get('device').id, sessionId });
    return c.json(answer(startResultSchema, result));
  },
);

devicePoolRoutes.post(
  '/me/pool/release',
  requireDevice(),
  releaseJob,
  zValidator('json', releaseBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { jobId, sessionId } = c.req.valid('json');
    if (jobId) {
      const released = await releaseJobFromMaster({ jobId, sessionId });
      return c.json(answer(releasedSchema, { released: released ? 1 : 0 }));
    }
    const released = await releaseAllHeldBySession(sessionId);
    return c.json(answer(releasedSchema, { released }));
  },
);

devicePoolRoutes.get(
  '/me/load',
  requireDevice(),
  readLoad,
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

    return c.json(answer(loadSchema, { device, project, fleet }));
  },
);

/**
 * Register (or re-find) this box's resident master for one project — B1's
 * bound, in the one place both halves can see it.
 */
devicePoolRoutes.post(
  '/me/master-session',
  requireDevice(),
  registerMasterSession,
  zValidator('json', masterSessionBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, name } = c.req.valid('json');
    const session = await ensureMasterSession({ deviceId: c.get('device').id, projectId, name });
    return c.json(answer(masterSessionSchema, session));
  },
);

/** The runner reporting a master it watched die (ISS-919 B3). */
devicePoolRoutes.post(
  '/me/master-session/close',
  requireDevice(),
  closeMasterSessionRoute,
  zValidator('json', masterCloseBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { sessionId, reason } = c.req.valid('json');
    const closed = await closeMasterSession({ deviceId: c.get('device').id, sessionId, reason });
    return c.json(answer(masterClosedSchema, { closed }));
  },
);

devicePoolRoutes.get('/me/protections', requireDevice(), listProtections, async (c) =>
  c.json(answer(protectionsSchema, { protections: [...PARK_PROTECTIONS] })),
);

/** The body as the kernel takes it: a parsed JSON body never holds an explicit `undefined`. */
type AskBody = Pick<AskInput, 'issueId' | 'agentSessionId' | 'assumed' | 'cost' | 'sensitive'> & {
  id: string;
  projectId: string;
  prompt: string;
  runId?: string | null;
  blockerKind?: QuestionBlockerKind | null;
  answerShape?: AnswerShape | null;
  options?: QuestionOption[] | null;
  recommendedOptionId?: string | null;
  needed?: string | null;
};

function askAnswerOf(body: AskBody): AskAnswer {
  if (body.answerShape === 'free_text') return { shape: 'free_text', needed: body.needed ?? '' };
  return {
    shape: 'choice',
    options: body.options ?? [],
    recommendedOptionId: body.recommendedOptionId ?? '',
  };
}

devicePoolRoutes.post(
  '/me/questions',
  requireDevice(),
  askQuestionRoute,
  takesBodyAsSent(
    'a box sends the question it was asked as it read it, and the extra keys are kept with the question',
  ),
  declaresInput('json', askQuestionBodySchema),
  async (c) => {
    const parsed = askQuestionBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw badRequest(z.flattenError(parsed.error));
    const body = parsed.data as AskBody;
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
      return c.json(answer(questionAskedSchema, { questionId: q.id }));
    } catch (e) {
      if (e instanceof QuestionRefused) {
        throw new HTTPException(400, {
          message: e.message,
          cause: { code: e.code, details: e.message },
        });
      }
      throw e;
    }
  },
);

devicePoolRoutes.get(
  '/me/questions/:questionId',
  requireDevice(),
  readQuestionAnswer,
  declaresInput('param', questionParamSchema),
  declaresInput('query', questionQuerySchema),
  async (c) => {
    const { questionId } = questionParamSchema.parse({ questionId: c.req.param('questionId') });
    const { runId } = questionQuerySchema.parse({ runId: c.req.query('runId') });
    const waiter = await waiterFor({ questionId, deviceId: c.get('device').id, runId });
    if (!waiter) throw notFound('question');
    return c.json(answer(questionAnswerSchema, { answer: await answerOf(questionId) }));
  },
);

devicePoolRoutes.post(
  '/me/limit',
  requireDevice(),
  reportMasterLimit,
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
    return c.json(answer(limitStampedSchema, { runnerId: stamped.runnerId }));
  },
);

devicePoolRoutes.delete('/me/limit', requireDevice(), clearMasterLimitRoute, async (c) => {
  const cleared = await clearMasterLimit(c.get('device').id);
  if (!cleared) throw notFound('claude-code runner for this device');
  return c.json(answer(limitStampedSchema, { runnerId: cleared.runnerId }));
});
