/**
 * ISS-55 — an issue's criteria and the verdicts on them, over REST. Transport only: the rules are
 * `store.ts` and `verdict-input.ts`, which every door calls.
 *
 *   GET  /api/issues/:id/criteria   live criteria in order, each with its latest verdict, and the retired ones with all their verdicts
 *   PUT  /api/issues/:id/criteria   the plan step's write: replace the criteria (renders the text),
 *                                   answering `verdicts`: which recorded verdicts it kept and voided
 *   GET  /api/issues/:id/criteria/:ref   one live criterion (`ref` its number or id) with its wording history
 *   PATCH /api/issues/:id/criteria/:ref  correct its wording: keeps its id and every verdict on it,
 *                                   recording the old and new text on its history
 *   POST /api/issues/:id/criteria/traces   tie it to business criteria of its requirement (appends; refreshes a trace on an earlier wording)
 *   POST /api/issues/:id/verdicts   one verdict on one criterion, with the probe it keeps, answering
 *                                   `notCounted` by name where it will never count (ISS-475)
 *   GET  /api/issues/:id/judged-build   the build a verdict on it defaults to (REQ-6 BC-2, BC-4)
 */

import { PROBE_SHAPE } from '@forge/contracts/criterion-probes';
import { Hono } from 'hono';
import { egressForRequest } from '../../lib/data-egress.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restActor,
} from '../../middleware/auth.js';
import { idParamSchema, notFound } from '../../middleware/route-errors.js';
import { nestedFieldShape, zValidator } from '../../middleware/zod-validator.js';
import { heldIssue, projectScopeQuery } from '../issue-route-ref.js';
import { judgedBuildOf } from '../ports.js';
import { findIssueById } from '../read-service.js';
import {
  criteriaPutSchema,
  criteriaTracePostSchema,
  criterionParamSchema,
  criterionPatchSchema,
  verdictPostSchema,
} from './input-schemas.js';
import {
  addVerdict,
  correctCriterion,
  readCriteriaWithDrafts as readCriteria,
  readCriteriaAndRetired,
  readCriterion,
  replaceCriteria,
  traceCriteria,
} from './service.js';

export const issueCriteriaRoutes = new Hono<{ Variables: AuthVars }>();

issueCriteriaRoutes.use('/:id/criteria', requireAuth(), assertEmailVerified());
// `/:id/criteria/:ref` also gates `/:id/criteria/traces`
issueCriteriaRoutes.use('/:id/criteria/:ref', requireAuth(), assertEmailVerified());
issueCriteriaRoutes.use('/:id/verdicts', requireAuth(), assertEmailVerified());
issueCriteriaRoutes.use('/:id/judged-build', requireAuth(), assertEmailVerified());

/** An issue's criteria, live and retired, as this caller may read them: every answer passes the same egress. */
async function criteriaShown(
  agency: Parameters<typeof egressForRequest>[0],
  issue: Parameters<typeof readCriteria>[0] & { projectId: string; id: string },
) {
  return egressForRequest(
    agency,
    issue.projectId,
    'issue.criteria',
    await readCriteriaAndRetired(issue),
    `the criteria of ${issue.id}`,
  );
}

issueCriteriaRoutes.get(
  '/:id/criteria',
  zValidator('param', idParamSchema),
  projectScopeQuery,
  async (c) => {
    const { id } = c.req.valid('param');
    const issue = await heldIssue(id, c.get('userId'), 'project.read');
    return c.json(await criteriaShown(c.get('agency'), issue));
  },
);

issueCriteriaRoutes.put(
  '/:id/criteria',
  zValidator('param', idParamSchema),
  zValidator('json', criteriaPutSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { criteria } = c.req.valid('json');
    const issue = await heldIssue(id, c.get('userId'), 'project.write');
    const verdicts = await replaceCriteria(id, criteria);
    if (!verdicts) throw notFound('issue not found');
    return c.json({ ...(await criteriaShown(c.get('agency'), issue)), verdicts });
  },
);

issueCriteriaRoutes.get(
  '/:id/criteria/:ref',
  zValidator('param', criterionParamSchema),
  projectScopeQuery,
  async (c) => {
    const { id, ref } = c.req.valid('param');
    const issue = await heldIssue(id, c.get('userId'), 'project.read');
    return c.json(
      await egressForRequest(
        c.get('agency'),
        issue.projectId,
        'issue.criteria',
        await readCriterion(issue, ref),
        `a criterion of ${issue.id}`,
      ),
    );
  },
);

issueCriteriaRoutes.patch(
  '/:id/criteria/:ref',
  zValidator('param', criterionParamSchema),
  zValidator('json', criterionPatchSchema),
  async (c) => {
    const { id, ref } = c.req.valid('param');
    const { statement, reason } = c.req.valid('json');
    const issue = await heldIssue(id, c.get('userId'), 'project.write');
    const done = await correctCriterion({
      issueId: issue.id,
      ref,
      statement,
      reason,
      actor: { type: 'user', id: c.get('userId'), agency: restActor(c).agency },
    });
    if (!done) throw notFound('issue not found');
    return c.json({
      ...done,
      // the id is kept, so every verdict recorded on the criterion stands on the corrected wording
      verdicts: { kept: done.keptVerdicts, voided: [] },
    });
  },
);

issueCriteriaRoutes.post(
  '/:id/criteria/traces',
  zValidator('param', idParamSchema),
  zValidator('json', criteriaTracePostSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { codes } = c.req.valid('json');
    const issue = await heldIssue(id, c.get('userId'), 'project.write');
    await traceCriteria(issue.id, codes);
    return c.json(await criteriaShown(c.get('agency'), issue), 201);
  },
);

issueCriteriaRoutes.post(
  '/:id/verdicts',
  zValidator('param', idParamSchema),
  zValidator(
    'json',
    verdictPostSchema,
    nestedFieldShape('probe', 'VERDICT_PROBE_SHAPE', PROBE_SHAPE),
  ),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const issue = await heldIssue(id, c.get('userId'), 'project.write');
    const written = await addVerdict({
      issue,
      draft: {
        criterion: body.criterion,
        verdict: body.verdict,
        reason: body.reason ?? null,
        identity: body.identity ?? null,
        evidence: body.evidence ?? [],
        judge: body.judge,
        probe: body.probe,
        withoutClip: body.withoutClip ?? null,
      },
      author: {
        userId: c.get('userId'),
        deviceId: c.get('patDeviceId') ?? null,
        agency: restActor(c).agency,
      },
      run: body.run,
    });
    const criterion = (await readCriteria(issue)).find((row) => row.n === written.criterion);
    return c.json(
      {
        verdictId: written.id,
        // this run's latest verdict on the criterion, sent again word for word: nothing was written
        duplicate: written.duplicate,
        criterion,
        notCounted: written.notCounted,
        countedUnderCutover: written.countedUnderCutover,
      },
      written.duplicate ? 200 : 201,
    );
  },
);

issueCriteriaRoutes.get(
  '/:id/judged-build',
  zValidator('param', idParamSchema),
  projectScopeQuery,
  async (c) => {
    const { id } = c.req.valid('param');
    await heldIssue(id, c.get('userId'), 'project.read');
    const issue = await findIssueById(id);
    if (!issue) throw notFound('issue not found');
    return c.json(
      await judgedBuildOf({
        id: issue.id,
        projectId: issue.projectId,
        mergedAt: issue.mergedAt,
        mergedCommitSha: issue.mergedCommitSha,
      }),
    );
  },
);
