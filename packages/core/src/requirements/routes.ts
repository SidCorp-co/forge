import { REASON_TEXT_MAX } from '@forge/contracts/comments';
import {
  ACCEPT_REQUIREMENT_SHAPE,
  acceptRequirementRequestSchema,
  DEFER_REQUIREMENT_SHAPE,
  DROP_REQUIREMENT_SHAPE,
  deferRequirementRequestSchema,
  dropRequirementRequestSchema,
  PROMOTE_REQUIREMENT_DRAFTS_SHAPE,
  promoteRequirementDraftsRequestSchema,
  REPIN_REQUIREMENT_SHAPE,
  REQUIREMENT_AREAS_SHAPE,
  REQUIREMENT_PLACEMENT_SHAPE,
  repinRequirementRequestSchema,
  requirementAreasRequestSchema,
  requirementPlacementRequestSchema,
  UNDEFER_REQUIREMENT_SHAPE,
  undeferRequirementRequestSchema,
} from '@forge/contracts/requirements';
import { REQUIREMENT_TITLE_MAX, titleText } from '@forge/contracts/title-text';
import { Hono } from 'hono';
import { z } from 'zod';
import { egressForRequest } from '../lib/data-egress.js';
import { logger } from '../lib/logger.js';
import { refused } from '../lib/refusal.js';
import { assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { holdChatWrite } from '../middleware/chat-write-hold.js';
import { strictBody } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { acceptDelivery, dropRequirement } from './acceptance.js';
import { agreeRequirement } from './agree.js';
import { requirementChecklistRoutes } from './checklist-routes.js';
import { requestContract } from './contract-request.js';
import { readRequirementDecisionsAs } from './decisions-read.js';
import { deferRequirement, undeferRequirement } from './deferral.js';
import { designsNamed, draftLinked } from './draft-linked.js';
import { requirementLinkRoutes } from './link-routes.js';
import {
  acceptPlacement,
  areasOf,
  proposeMissingPlacements,
  proposePlacement,
  setAreas,
  setPlacement,
} from './placement.js';
import { requirementSummaryOf } from './projection.js';
import { promoteDraftIssues } from './promote-drafts.js';
import { listRequirementsAs, readRequirementAs } from './read.js';
import { repinRequirement } from './repin.js';
import { revisionRoutes } from './revision-routes.js';
import {
  actorOf,
  answer,
  decisionsQuery,
  draftPictureFits,
  projectParam,
  type RequirementEnv,
  reqParam,
  revisionFields,
  viewQuery,
} from './route-kit.js';

export const requirementRoutes = new Hono<RequirementEnv>();

for (const path of ['/:id/requirements', '/:id/requirements/*', '/:id/contract-requests']) {
  requirementRoutes.use(path, requireAuth(), assertEmailVerified());
}

requirementRoutes.get('/:id/requirements', projectParam, viewQuery, async (c) => {
  const { id } = c.req.valid('param');
  const listed = await egressForRequest(
    c.get('agency'),
    id,
    'requirement',
    await listRequirementsAs(actorOf(c), id),
    'the requirement list',
  );
  const requirements =
    c.req.valid('query').view === 'summary' ? listed.map(requirementSummaryOf) : listed;
  return c.json({ requirements, returned: requirements.length });
});

requirementRoutes.get('/:id/requirements/:req/decisions', reqParam, decisionsQuery, async (c) => {
  const { id, req } = c.req.valid('param');
  return c.json(await readRequirementDecisionsAs(actorOf(c), id, req, {}, c.req.valid('query').by));
});

requirementRoutes.post(
  '/:id/requirements',
  projectParam,
  strictBody(
    z.strictObject({
      title: titleText(REQUIREMENT_TITLE_MAX),
      ...revisionFields,
      criteria: revisionFields.criteria.default([]),
      designs: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
    }),
    '{ title, reason?, spec?, kind?: process | rule | screen | report | null, picture?: { kind, content, alt? } drawn with it (alt left out is written from the content), tldr?, changeSummary?, writtenLang?: en | vi, criteria?: [{ body, form? }], designs?: [flow name or id] } writes REQ-n at revision 1 from its title alone if need be, linked to each design named; without a reason, its author is asked why',
  ),
  draftPictureFits('new'),
  holdChatWrite('requirement_draft'),
  async (c) => {
    const { title, designs, ...write } = c.req.valid('json');
    const projectId = c.req.valid('param').id;
    const linked = await designsNamed(projectId, designs ?? []);
    if (!linked.ok) return refused(c, [linked.refusal], 'REQUIREMENT_REFUSED');
    const outcome = await draftLinked({
      projectId,
      actor: actorOf(c),
      title,
      write,
      workflowIds: linked.ids,
    });
    // the assistant proposes the area and short name from what was just written; a person accepts
    if (outcome.ok) {
      void proposePlacement(projectId, outcome.requirement.id).catch((err: unknown) =>
        logger.warn({ err }, 'requirement placement: the proposal on create failed'),
      );
    }
    return answer(c, outcome);
  },
);

// E2: another project's contract request lands as a draft requirement in its provider; `:id` is
// the requesting project, and the answer names the provider's draft by key
requirementRoutes.post(
  '/:id/contract-requests',
  projectParam,
  strictBody(
    z.strictObject({
      contract: z
        .string()
        .trim()
        .regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/),
      title: titleText(REQUIREMENT_TITLE_MAX),
      ...revisionFields,
      criteria: revisionFields.criteria.default([]),
    }),
    '{ contract: "<provider>/<contract>", title, reason?, spec?, kind?: process | rule | screen | report | null, picture?: { kind, content, alt? } drawn with it (alt left out is written from the content), tldr?, changeSummary?, writtenLang?: en | vi, criteria?: [{ body, form? }] } lands a draft requirement in the provider',
  ),
  async (c) => {
    const { contract, title, ...write } = c.req.valid('json');
    const outcome = await requestContract({
      projectId: c.req.valid('param').id,
      actor: actorOf(c),
      contract,
      title,
      write,
    });
    if (!outcome.ok) return refused(c, outcome.refusals, 'REQUIREMENT_REFUSED');
    return c.json(outcome.request, 201);
  },
);

requirementRoutes.get('/:id/requirements/:req', reqParam, async (c) => {
  const { id, req } = c.req.valid('param');
  return c.json(
    await egressForRequest(
      c.get('agency'),
      id,
      'requirement',
      await readRequirementAs(actorOf(c), id, req),
      req,
    ),
  );
});

requirementRoutes.get('/:id/requirement-areas', projectParam, async (c) => {
  const projectId = c.req.valid('param').id;
  await requireCan(actorFor(actorOf(c).userId), 'project.read', projectResource(projectId));
  return c.json({ areas: await areasOf(projectId) });
});

requirementRoutes.put(
  '/:id/requirement-areas',
  projectParam,
  strictBody(requirementAreasRequestSchema, REQUIREMENT_AREAS_SHAPE),
  holdChatWrite('requirement_draft'),
  async (c) => {
    const projectId = c.req.valid('param').id;
    const out = await setAreas({
      projectId,
      actor: actorOf(c),
      names: c.req.valid('json').names,
    });
    if (!out.ok) return refused(c, out.refusals, 'REQUIREMENT_REFUSED');
    return c.json({ areas: out.areas });
  },
);

// a person asks the assistant to propose an area and short name for every requirement without one
requirementRoutes.post('/:id/requirement-areas/propose', projectParam, async (c) => {
  const projectId = c.req.valid('param').id;
  return c.json(await proposeMissingPlacements(projectId, actorOf(c)), 202);
});

requirementRoutes.put(
  '/:id/requirements/:req/placement',
  reqParam,
  strictBody(requirementPlacementRequestSchema, REQUIREMENT_PLACEMENT_SHAPE),
  holdChatWrite('requirement_revision'),
  async (c) => {
    const { id, req } = c.req.valid('param');
    return answer(
      c,
      await setPlacement({ projectId: id, ref: req, actor: actorOf(c), ...c.req.valid('json') }),
    );
  },
);

requirementRoutes.post('/:id/requirements/:req/placement/accept', reqParam, async (c) => {
  const { id, req } = c.req.valid('param');
  return answer(c, await acceptPlacement({ projectId: id, ref: req, actor: actorOf(c) }));
});

requirementRoutes.route('/', revisionRoutes);

requirementRoutes.post(
  '/:id/requirements/:req/agree',
  reqParam,
  strictBody(
    z.strictObject({
      revision: z.number().int().min(1),
      reason: z.string().max(REASON_TEXT_MAX).nullable().optional(),
    }),
    '{ revision, reason } names the head revision being agreed and says why it is signed',
  ),
  async (c) => {
    const { id, req } = c.req.valid('param');
    const body = c.req.valid('json');
    return answer(
      c,
      await agreeRequirement({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        revision: body.revision,
        reason: body.reason,
      }),
    );
  },
);

requirementRoutes.post(
  '/:id/requirements/:req/repin',
  reqParam,
  strictBody(repinRequirementRequestSchema, REPIN_REQUIREMENT_SHAPE),
  async (c) => {
    const { id, req } = c.req.valid('param');
    const body = c.req.valid('json');
    return answer(
      c,
      await repinRequirement({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        revision: body.revision,
        reason: body.reason,
      }),
    );
  },
);

// FB-93: the act that answers "promote N draft issues"; one moved answers 200 naming any refused
requirementRoutes.post(
  '/:id/requirements/:req/promote',
  reqParam,
  strictBody(promoteRequirementDraftsRequestSchema, PROMOTE_REQUIREMENT_DRAFTS_SHAPE),
  async (c) => {
    const { id, req } = c.req.valid('param');
    const outcome = await promoteDraftIssues({
      projectId: id,
      ref: req,
      actor: actorOf(c),
      issues: c.req.valid('json').issues,
    });
    if (!outcome.ok) return refused(c, outcome.refusals, 'REQUIREMENT_REFUSED');
    const { requirement, promoted, refused: notMoved } = outcome;
    return c.json({ requirement, promoted, refused: notMoved });
  },
);

requirementRoutes.post(
  '/:id/requirements/:req/defer',
  reqParam,
  strictBody(deferRequirementRequestSchema, DEFER_REQUIREMENT_SHAPE),
  async (c) => {
    const { id, req } = c.req.valid('param');
    const body = c.req.valid('json');
    return answer(
      c,
      await deferRequirement({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        reason: body.reason,
        targetPhase: body.targetPhase,
      }),
    );
  },
);

requirementRoutes.post(
  '/:id/requirements/:req/undefer',
  reqParam,
  strictBody(undeferRequirementRequestSchema, UNDEFER_REQUIREMENT_SHAPE),
  async (c) => {
    const { id, req } = c.req.valid('param');
    return answer(
      c,
      await undeferRequirement({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        reason: c.req.valid('json').reason,
      }),
    );
  },
);

requirementRoutes.post(
  '/:id/requirements/:req/accept',
  reqParam,
  strictBody(acceptRequirementRequestSchema, ACCEPT_REQUIREMENT_SHAPE),
  async (c) => {
    const { id, req } = c.req.valid('param');
    const body = c.req.valid('json');
    return answer(
      c,
      await acceptDelivery({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        revision: body.revision,
        reason: body.reason,
      }),
    );
  },
);

requirementRoutes.post(
  '/:id/requirements/:req/drop',
  reqParam,
  strictBody(dropRequirementRequestSchema, DROP_REQUIREMENT_SHAPE),
  async (c) => {
    const { id, req } = c.req.valid('param');
    return answer(
      c,
      await dropRequirement({
        projectId: id,
        ref: req,
        actor: actorOf(c),
        reason: c.req.valid('json').reason,
      }),
    );
  },
);

requirementRoutes.route('/', requirementLinkRoutes);
requirementRoutes.route('/', requirementChecklistRoutes);
