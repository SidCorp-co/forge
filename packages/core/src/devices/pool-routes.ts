/**
 * The device-facing half of master orchestration: read the pool, take work,
 * give it back, and read load.
 *
 * Every route here is the device's own principal — the master reaches core
 * only through its daemon, so there is one holder of the device token.
 */

import { PARK_PROTECTIONS } from '@forge/contracts/questions';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { runnerLimitReasons } from '../db/schema.js';
import {
  answerShapes,
  optionAuthorities,
  optionBindings,
  optionExecutors,
  questionBlockerKinds,
} from '../db/schema-questions.js';
import { utf16String } from '../lib/utf16-string.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { zValidator } from '../middleware/zod-validator.js';
import { assertDeviceBoundToProject } from './device-project.js';
import { refuseDevice } from './refusals.js';
import { notFound, sessionParamsSchema } from './route-errors.js';

const ASK_REQUIRED = 'id, projectId and prompt are required';
const askRequired = z.string({ error: ASK_REQUIRED }).min(1, { error: ASK_REQUIRED });

const askBodySchema = z.object({
  id: askRequired,
  projectId: askRequired,
  issueId: z.string().optional(),
  agentSessionId: z.string().optional(),
  runId: z.string().optional(),
  prompt: askRequired,
  blockerKind: z.enum(questionBlockerKinds).optional(),
  answerShape: z.enum(answerShapes).optional(),
  options: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        authority: z.enum(optionAuthorities),
        bindsTo: z.enum(optionBindings),
        executedBy: z.enum(optionExecutors),
        fingerprint: z.string().optional(),
      }),
    )
    .optional(),
  recommendedOptionId: z.string().optional(),
  needed: z.string().optional(),
  assumed: z.record(z.string(), z.unknown()).optional(),
  cost: z
    .object({
      claimsHeld: z.number().optional(),
      workspacesPinned: z.number().optional(),
      dependents: z.number().optional(),
    })
    .optional(),
  sensitive: z.boolean().optional(),
});

type AskBody = z.infer<typeof askBodySchema>;

const answerQuerySchema = z.object({ runId: z.string().optional() });

import { type ResolvedLeaseKey, readDeviceIssueLease, resolveLeaseKey } from '../issues/index.js';
import { releaseHoldsOf, releaseJobHold } from '../jobs/index.js';
import { RefusalError } from '../lib/refusal.js';
import { readAdmissibleIssues } from './admissible.js';
import { assertMasterSessionHeld, prepareJobForMaster, startJobForMaster } from './claim.js';
import { deviceCommentInboxRoutes } from './comment-inbox-routes.js';
import { clearMasterLimit, recordMasterLimit } from './master-limit.js';
import { closeMasterSession } from './master-session.js';
import { readPool } from './pool.js';
import { devicesPorts } from './ports.js';
import { readRunSessionTerminal, releaseIssueLease } from './run-session.js';
import { deviceRunSessionRoutes } from './run-session-routes.js';

export const devicePoolRoutes = new Hono<{ Variables: DeviceVars }>();

// The device's run-session and inbox routes live in their own files and mount here.
devicePoolRoutes.route('/', deviceRunSessionRoutes);
devicePoolRoutes.route('/', deviceCommentInboxRoutes);

const poolQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  projectId: z.string().uuid().optional(),
});

devicePoolRoutes.get(
  '/me/pool',
  requireDevice(),
  zValidator('query', poolQuerySchema),
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
  zValidator('query', poolQuerySchema),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const { items, refused } = await readAdmissibleIssues({
      deviceId: c.get('device').id,
      projectId,
    });
    return c.json({ items, count: items.length, refused });
  },
);

const leaseParamsSchema = z.object({ issueKey: z.string().min(1).max(64) });
const leaseQuerySchema = z.object({ projectId: z.string().uuid().optional() });

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
  const { code, message } = resolved.refusal;
  throw new RefusalError([{ code, path: '/issueKey', detail: message }], code);
}

devicePoolRoutes.get(
  '/me/run-sessions/:sessionId',
  requireDevice(),
  zValidator('param', sessionParamsSchema),
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
  zValidator('param', leaseParamsSchema),
  zValidator('query', leaseQuerySchema),
  async (c) => {
    const key = await leaseKeyOf(c.req.valid('param').issueKey, c.req.valid('query').projectId);
    // Two questions, both answered, because they are different ones: `held` is
    // the fleet-wide fact, `heldByThisDevice` is what a close loop asking
    // "have I given this back" means. Answering the second under the first
    // name is the defect ISS-1109 closed.
    return c.json(
      await readDeviceIssueLease({
        deviceId: c.get('device').id,
        issueKey: key.issueKey,
        projectId: key.projectId,
      }),
    );
  },
);

devicePoolRoutes.delete(
  '/me/issue-leases/:issueKey',
  requireDevice(),
  zValidator('param', leaseParamsSchema),
  zValidator('query', leaseQuerySchema),
  async (c) => {
    const rawKey = c.req.valid('param').issueKey;
    const key = await leaseKeyOf(rawKey, c.req.valid('query').projectId);
    const outcome = await releaseIssueLease({
      deviceId: c.get('device').id,
      issueKey: key.issueKey,
      projectId: key.projectId,
    });
    if (outcome.released) {
      return c.json({ ok: true, issueKey: key.issueKey, projectId: outcome.projectId });
    }
    // A delete that matched nothing is not a success: the box reads the ack as
    // the issue handed back and stops watching it (ISS-1139).
    if (outcome.reason === 'ambiguous') {
      throw refuseDevice(
        'ISSUE_LEASE_AMBIGUOUS',
        [
          `this box holds ${outcome.projectIds.length} leases on ${key.issueKey}, one per project, and nothing was given back.`,
          ...outcome.projectIds.map((id) => `  ${key.issueKey} in project ${id}`),
          "A lease is given back for the project it was taken for, so name one: send `?projectId=<id>`, or that project's own issue prefix in the key.",
        ].join('\n'),
      );
    }
    throw new HTTPException(404, {
      message: `no lease on ${key.issueKey}${key.projectId ? ` in project ${key.projectId}` : ''} is held by this box, so nothing was given back. \`${rawKey}\` resolved to the canonical \`${key.issueKey}\`, which is the form the lease store keeps.`,
      cause: { code: 'ISSUE_LEASE_NOT_HELD', details: { issueKey: key.issueKey } },
    });
  },
);

const claimBodySchema = z.object({
  jobId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

/**
 * Take a job without starting it (ISS-919 B2).
 *
 * The job comes back `queued` and held, with its token and preparation. The
 * caller owes `/me/pool/start` or a release. Nothing taken is a refusal under a
 * `POOL_*` code with its declared status (`@forge/contracts/devices`).
 */
devicePoolRoutes.post(
  '/me/pool/prepare',
  requireDevice(),
  zValidator('json', claimBodySchema),
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
  zValidator('json', claimBodySchema),
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
  zValidator('json', releaseBodySchema),
  async (c) => {
    const { jobId, sessionId } = c.req.valid('json');
    // A master that died still owns the holds it left, so its box may give them back.
    await assertMasterSessionHeld({ deviceId: c.get('device').id, sessionId, live: false });
    if (jobId) {
      const released = await releaseJobHold(jobId, sessionId);
      return c.json({ released: released ? 1 : 0 });
    }
    const released = await releaseHoldsOf(sessionId);
    return c.json({ released });
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
  zValidator('json', masterCloseBodySchema),
  async (c) => {
    const { sessionId, reason } = c.req.valid('json');
    const closed = await closeMasterSession({ deviceId: c.get('device').id, sessionId, reason });
    return c.json({ closed });
  },
);

devicePoolRoutes.get('/me/protections', requireDevice(), async (c) =>
  c.json({ protections: PARK_PROTECTIONS }),
);

function askAnswerOf(body: AskBody) {
  if (body.answerShape === 'free_text') {
    return { shape: 'free_text' as const, needed: body.needed ?? '' };
  }
  return {
    shape: 'choice' as const,
    options: (body.options ?? []).map(({ fingerprint, ...o }) =>
      fingerprint === undefined ? o : { ...o, fingerprint },
    ),
    recommendedOptionId: body.recommendedOptionId ?? '',
  };
}

devicePoolRoutes.post(
  '/me/questions',
  requireDevice(),
  zValidator('json', askBodySchema),
  async (c) => {
    const body = c.req.valid('json');
    await assertDeviceBoundToProject(c.get('device').id, body.projectId);
    const q = await devicesPorts().questions.askQuestion({
      ...body,
      id: body.id,
      projectId: body.projectId,
      prompt: body.prompt,
      blockerKind: body.blockerKind ?? 'human',
      answer: askAnswerOf(body),
    });
    if (body.runId) {
      await devicesPorts().questions.registerWaiter({
        questionId: q.id,
        deviceId: c.get('device').id,
        runId: body.runId,
      });
    }
    return c.json({ questionId: q.id });
  },
);

devicePoolRoutes.get(
  '/me/questions/:questionId',
  requireDevice(),
  zValidator('query', answerQuerySchema),
  async (c) => {
    const questionId = c.req.param('questionId');
    const waiter = await devicesPorts().questions.waiterFor({
      questionId,
      deviceId: c.get('device').id,
      runId: c.req.valid('query').runId ?? '',
    });
    if (!waiter) throw notFound('question');
    return c.json({ answer: await devicesPorts().questions.answerOf(questionId) });
  },
);

const masterLimitSchema = z.object({
  reason: z.enum(runnerLimitReasons),
  resetsInSeconds: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60 * 60)
    .nullish(),
  detail: utf16String(200).min(1),
});

devicePoolRoutes.post(
  '/me/limit',
  requireDevice(),
  zValidator('json', masterLimitSchema),
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
