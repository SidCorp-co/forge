import { REASON_PARAGRAPH_MAX } from '@forge/contracts/comments';
import { ReleaseNamingSchema } from '@forge/contracts/release-notes';
import {
  ReleaseRangeReadsBodySchema,
  ReleaseRangeReportSchema,
} from '@forge/contracts/release-page';
import { RELEASE_HOLD_OWERS, RELEASE_ROSTER_LIMIT } from '@forge/contracts/releases';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { notFound } from '../middleware/route-errors.js';
import { invalid, noQuery, zValidator } from '../middleware/zod-validator.js';
import { requireHeld, requireMasterAct, requiresOnResolved } from '../permissions/index.js';
import { readGateProfile } from '../project-config/index.js';
import { carriedSchema, declareCarried } from './carried.js';
import { createReleaseBatch } from './create.js';
import { abortReleaseBatch } from './finish.js';
import { acceptReleaseBatchFinish } from './finish-job.js';
import { resolveReleaseDeclaration } from './gate.js';
import { announceMethod } from './method.js';
import { recordPromotionRelease } from './promotion-release.js';
import {
  findReleaseBatchRun,
  getActiveReleaseBatch,
  loadReleaseBatchContext,
  loadReleaseRoster,
} from './queries.js';
import { loadReleaseReadiness } from './readiness.js';
import { readReleaseRecord, recordPerformedRelease } from './recorded.js';
import { recordLanding } from './recorded-landing.js';
import { refuseRelease } from './refuse.js';
import { recordShippedIn } from './shipped-in.js';
import { correctShippedIn } from './shipped-in-correct.js';
import { rangeBaseOf, rangeReads, recordRange } from './shipped-range.js';
import { readReleaseRunState } from './state.js';
import { RELEASE_VERSION_SHAPE } from './version.js';
import { releaseVersionRoutes } from './version-routes.js';
import { givenReleaseVersion } from './version-store.js';

const projectParamSchema = z.object({ projectId: z.uuid() });

/** A roster names each issue once; a uuid is one id in either letter case. */
const rosterIdsSchema = z.array(z.uuid()).superRefine((ids, ctx) => {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        message: `issueIds names ${id} more than once, counting either letter case as the same id: send each issue once.`,
      });
      return;
    }
    seen.add(id.toLowerCase());
  }
});

const createBodySchema = z
  .object({
    /**
     * No size here: `collectReleaseBlockers` owns the limit and the empty gate,
     * so both are refused by the code readiness lists them under rather than as
     * a schema's `Invalid input` (ISS-1127 criterion 1).
     */
    issueIds: rosterIdsSchema,
    /** The release's name and summary (REQ-40 BC-14); both or neither, each held to `ReleaseNamingSchema`. */
    name: z.string().optional(),
    summary: z.string().optional(),
    /** The merge order of a release that ships by merging change requests, by number (REQ-63). */
    changeRequests: z
      .array(z.number().int().positive())
      .min(1)
      .max(RELEASE_ROSTER_LIMIT)
      .optional(),
    /** A promotion project's cut names the change request that carries the roster the agent states. */
    promotion: z.object({ request: z.number().int().positive() }).strict().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.name === undefined && body.summary === undefined) return;
    const naming = ReleaseNamingSchema.safeParse({ name: body.name, summary: body.summary });
    for (const issue of naming.success ? [] : naming.error.issues)
      ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });

/**
 * The cut and the record take project.admin, and outside strict the project's master holds them too
 * (REQ-79 r6 BC-17), so an agent alone takes a landed issue through the release that closes it.
 */
async function requireReleaseAct(
  c: Context<{ Variables: AuthVars }>,
  projectId: string,
  act: string,
): Promise<void> {
  const access = await loadProjectAccess(projectId, c.get('userId'));
  const ask = { agency: restActor(c).agency, profile: await readGateProfile(projectId) };
  requireMasterAct(access, 'project.admin', ask, act);
}

export const releaseBatchRoutes = new Hono<{ Variables: AuthVars }>();
releaseBatchRoutes.use('*', requireAuth(), assertEmailVerified());

releaseBatchRoutes.post(
  '/:projectId/release-batches',
  zValidator('param', projectParamSchema),
  zValidator('json', createBodySchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const { issueIds, name, summary, changeRequests, promotion } = c.req.valid('json');
    const userId = c.get('userId');

    await requireReleaseAct(c, projectId, 'cutting a release');

    const naming = name !== undefined && summary !== undefined ? { name, summary } : null;
    const result = await createReleaseBatch({
      projectId,
      issueIds,
      userId,
      naming,
      changeRequests,
      promotion,
    });
    return c.json(result, 201);
  },
);

releaseBatchRoutes.get(
  '/:projectId/release-batches/active',
  zValidator('param', projectParamSchema),
  noQuery,
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.write');

    const active = await getActiveReleaseBatch(projectId);
    return c.json(active ?? null);
  },
);

releaseBatchRoutes.get(
  '/:projectId/release-batches/roster',
  zValidator('param', projectParamSchema),
  noQuery,
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.write');

    return c.json(await loadReleaseRoster(projectId));
  },
);

releaseBatchRoutes.get(
  '/:projectId/release-readiness',
  zValidator('param', projectParamSchema),
  noQuery,
  async (c) => {
    const { projectId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    requireHeld(access, 'project.write');

    const readiness = await loadReleaseReadiness(projectId);
    if (!readiness) throw notFound('project not found');
    return c.json(readiness);
  },
);

const runParamSchema = z.object({ projectId: z.uuid(), runId: z.uuid() });

const finishBodySchema = z.object({ commit: z.string().trim().max(200).optional() }).strict();
const abortBodySchema = z
  .object({
    reason: z.string().trim().max(REASON_PARAGRAPH_MAX).optional(),
    /**
     * What to do with a roster whose run already promoted. Absent is `hold`, which is what this
     * door did before the choice existed (ISS-1199).
     */
    promotedRoster: z.enum(['hold', 'return-to-gate']).optional(),
    /**
     * Who has to act before this roster can release, and what they owe. `human` holds the roster
     * from every unattended cut until a person acts; absent, the roster goes back to the gate for
     * the next cut, as it did before the field existed.
     */
    blocker: z
      .object({
        owes: z.enum(RELEASE_HOLD_OWERS),
        waitingFor: z.string().trim().min(1).max(500),
      })
      .strict()
      .optional(),
    /**
     * Whether this run pushed anything for this release (the release commit to any branch, or its
     * tag). `false` says nothing left the box, and the next attempt at this roster wears this
     * version again; absent says nothing, and that attempt is refused `RELEASE_VERSION_UNDECIDED`
     * until somebody says (ADR 0011).
     */
    pushed: z.boolean().optional(),
    /**
     * What outside Forge now carries this release's version — each pushed tag, release commit,
     * published artifact or notice sent, by the name it goes by there. Any one makes the next
     * attempt take a new version, and its page names this. `[]` says nothing does.
     */
    carried: carriedSchema.optional(),
    /**
     * The earlier shipped release that already holds this roster, as the run read it with git: each
     * roster issue is recorded as shipped there, as `POST /shipped-in-records` records it (ISS-888).
     * Absent, a roster issue an earlier shipped release may hold waits on its agent's record instead.
     */
    shippedIn: z
      .object({
        version: z.string().trim().min(1).max(100),
        evidence: z.string().trim().min(10).max(2_000),
      })
      .strict()
      .optional(),
  })
  .strict();

const carriedBodySchema = z.object({ carried: carriedSchema }).strict();

/**
 * `account` has a floor because it is the whole of Rule 2 of ISS-1129: a release
 * performed by hand and a release performed by a batch are different facts, and
 * "released" with no account of how is the silent substitution this repository
 * refuses everywhere else. Twenty characters does not make an account good; it
 * makes `ok` refused.
 */
const releaseRecordBodySchema = z
  .object({
    issueIds: rosterIdsSchema.min(1),
    /** The release the agent shipped, `v1.31.1` or `1.31.1`; required wherever production is declared,
     *  optional on a landing, which Forge versions where absent. */
    version: z.string().trim().min(1).max(100).optional(),
    /** A sha the agent carries as evidence: never required, never compared or checked. */
    commit: z.string().trim().min(1).max(200).optional(),
    account: z.string().trim().min(20).max(20_000),
    providerRef: z.string().trim().max(500).optional(),
    /** A landing's branch, where it is not the one work lands on (adminhub-api !5020, 2026-10-27). */
    branch: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

/** The version a production release is recorded under, refused by name where missing or misshapen. */
function recordedVersion(sent: string | undefined): string {
  if (sent === undefined) {
    throw refuseRelease(
      'RELEASE_VERSION_MISSING',
      'A release is recorded under the version you released: send `version`, e.g. `v1.31.1`.',
      '/version',
    );
  }
  const version = givenReleaseVersion(sent);
  if (!version) {
    throw refuseRelease(
      'RELEASE_VERSION_SHAPE',
      `\`${sent}\` is no release version: send ${RELEASE_VERSION_SHAPE}, with or without a leading \`v\`.`,
      '/version',
    );
  }
  return version;
}

async function loadRunForProject(runId: string, projectId: string, userId: string) {
  const run = await findReleaseBatchRun(runId);
  if (!run || run.projectId !== projectId) throw notFound('release batch not found');

  const access = await loadProjectAccess(projectId, userId);
  requireHeld(access, 'project.write');
  return run;
}

releaseBatchRoutes.get(
  '/:projectId/release-batches/:runId',
  zValidator('param', runParamSchema),
  noQuery,
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    await loadRunForProject(runId, projectId, c.get('userId'));
    return c.json(await loadReleaseBatchContext(runId));
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/finish',
  zValidator('param', runParamSchema),
  zValidator('json', finishBodySchema),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const userId = c.get('userId');
    await loadRunForProject(runId, projectId, userId);

    const accepted = await acceptReleaseBatchFinish(runId, restActor(c), c.req.valid('json'));
    return c.json(
      { runId, finish: accepted.finish },
      accepted.finish.state === 'finished' ? 200 : 202,
    );
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/abort',
  zValidator('param', runParamSchema),
  zValidator('json', abortBodySchema),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const { reason, promotedRoster, blocker, pushed, carried, shippedIn } = c.req.valid('json');
    const userId = c.get('userId');
    await loadRunForProject(runId, projectId, userId);

    const result = await abortReleaseBatch(runId, reason ?? 'aborted by agent', userId, {
      promotedRoster,
      blocker,
      pushed,
      carried,
      shippedIn,
    });
    return c.json({ aborted: true, releasedIds: result.claimsCleared, ...result });
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/carried',
  zValidator('param', runParamSchema),
  zValidator(
    'json',
    carriedBodySchema,
    invalid(
      'the body is { carried: [{ kind: "tag" | "commit" | "artifact" | "notice", name }] }, `[]` when nothing outside Forge carries the version',
      'RELEASE_CARRIED_SHAPE',
    ),
  ),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const userId = c.get('userId');
    await loadRunForProject(runId, projectId, userId);
    const { carried } = c.req.valid('json');
    return c.json(await declareCarried({ projectId, runId, carried, by: userId }));
  },
);

const methodBodySchema = z
  .object({
    skill: z.string().trim().min(1).max(200),
    loaded: z.boolean(),
    detail: z.string().trim().max(4_000).optional(),
  })
  .strict();

releaseBatchRoutes.get(
  '/:projectId/release-batches/:runId/state',
  zValidator('param', runParamSchema),
  noQuery,
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    await loadRunForProject(runId, projectId, c.get('userId'));
    const state = await readReleaseRunState(runId);
    if (!state) throw notFound('release batch not found');
    return c.json(state);
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/method',
  zValidator('param', runParamSchema),
  zValidator('json', methodBodySchema),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    await loadRunForProject(runId, projectId, c.get('userId'));
    return c.json(await announceMethod({ runId, ...c.req.valid('json') }));
  },
);

// REQ-40 BC-7, BC-9 — the run that cut the release reports what its range ships, from its checkout:
// where the range starts, which of its changed files the reader reads, then those files' two ends.
releaseBatchRoutes.get(
  '/:projectId/release-batches/:runId/range',
  zValidator('param', runParamSchema),
  noQuery,
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const run = await loadRunForProject(runId, projectId, c.get('userId'));
    return c.json(await rangeBaseOf(projectId, run.version));
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/range/reads',
  zValidator('param', runParamSchema),
  zValidator('json', ReleaseRangeReadsBodySchema),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    await loadRunForProject(runId, projectId, c.get('userId'));
    return c.json({ reads: rangeReads(c.req.valid('json').changes) });
  },
);

releaseBatchRoutes.post(
  '/:projectId/release-batches/:runId/range',
  zValidator('param', runParamSchema),
  zValidator('json', ReleaseRangeReportSchema),
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const run = await loadRunForProject(runId, projectId, c.get('userId'));
    const report = c.req.valid('json');
    return c.json(await recordRange({ projectId, runId, version: run.version, report }));
  },
);

// ISS-1129 — the release that already happened, and the read of what was written. Under release
// mode `none` it is the landing on the working branch, recorded as that (`recorded-landing.ts`).
//
// Registered on this router rather than on one of its own, so the `use('*')`
// at the top covers them and `check-pat-surface` — which reads routes off the
// router file `index.ts` mounts — can see that both reach the fence.
releaseBatchRoutes.post(
  '/:projectId/release-records',
  zValidator('param', projectParamSchema),
  requiresOnResolved(
    'project.admin',
    'the project `:projectId` names; outside strict its master holds the act too (REQ-79 r6 BC-17)',
  ),
  zValidator('json', releaseRecordBodySchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    await requireReleaseAct(c, projectId, 'recording a release');

    // With no production environment the landing is the delivery, under the agent's version or one
    // Forge cuts; anywhere else a release is the agent's record under the version it shipped (owner, 2026-11-01).
    const declared = await resolveReleaseDeclaration(projectId);
    const sent = { projectId, userId, ...c.req.valid('json') };
    if (declared?.kind === 'no-release') {
      // a landing takes the version the agent names, else one Forge cuts (REQ-45 r7 BC-11)
      const version = sent.version === undefined ? undefined : recordedVersion(sent.version);
      return c.json(await recordLanding({ ...sent, version }, declared.defaultBranch), 201);
    }
    if (sent.branch !== undefined) {
      throw refuseRelease(
        'RELEASE_RECORD_BRANCH_UNUSED',
        '`branch` names where a landing is recorded, and this project declares a production environment, whose record is the version it released: send the record without `branch`.',
        '/branch',
      );
    }
    const version = recordedVersion(sent.version);
    const result =
      declared?.kind === 'promotion'
        ? await recordPromotionRelease({ ...sent, version }, declared)
        : await recordPerformedRelease({ ...sent, version });
    return c.json(result, 201);
  },
);

const shippedInBodySchema = z
  .object({
    issueId: z.uuid(),
    /** The shipped release that holds the issue's landing; null where none does (ISS-774). */
    version: z.string().trim().min(1).max(100).nullable(),
    /** What the agent read to say so: the git command and its answer. */
    evidence: z.string().trim().min(10).max(2_000),
    /** The version a closed issue's shipped-in record names now, which this record replaces (ISS-846). */
    corrects: z.string().trim().min(1).max(100).optional(),
    /** Why the record `corrects` replaces was wrong; required with it, refused without it. */
    reason: z.string().trim().max(REASON_PARAGRAPH_MAX).optional(),
  })
  .strict();

// ISS-774 — which earlier release shipped an issue marked merged after that release was cut, as its
// agent read it with git. Forge infers none of it; it refuses only what its own rows contradict.
// ISS-846 — with `corrects`, the same record moves a closed issue off the release a wrong record named.
releaseBatchRoutes.post(
  '/:projectId/shipped-in-records',
  zValidator('param', projectParamSchema),
  zValidator('json', shippedInBodySchema),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.write');
    const { corrects, reason, ...sent } = c.req.valid('json');
    if (corrects !== undefined) {
      return c.json(await correctShippedIn({ projectId, userId, ...sent, corrects, reason }), 201);
    }
    if (reason !== undefined) {
      throw refuseRelease(
        'RELEASE_SHIPPED_IN_REASON_UNUSED',
        '`reason` says why a corrected record was wrong, and this record corrects none: send it without `reason`, or name the version it replaces in `corrects`.',
        '/reason',
      );
    }
    const result = await recordShippedIn({ projectId, userId, ...sent });
    return c.json(result, 201);
  },
);

releaseBatchRoutes.get(
  '/:projectId/release-records/:runId',
  zValidator('param', runParamSchema),
  noQuery,
  async (c) => {
    const { projectId, runId } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    requireHeld(access, 'project.write');

    const record = await readReleaseRecord(projectId, runId);
    if (!record) throw notFound('no release record under this id on this project');
    return c.json(record);
  },
);

releaseBatchRoutes.route('/', releaseVersionRoutes);
