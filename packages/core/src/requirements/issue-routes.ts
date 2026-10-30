/**
 * The requirement an issue delivers, over REST, read through the issue:
 *
 *   GET /api/issues/:id/requirement   the requirement its `requirement_id` names, of whichever project
 *                                     of its organization: its current revision (spec, criteria with
 *                                     code and body) and its latest baseline (`issue-requirement-read.ts`)
 *
 * The caller is authorised on the issue's project alone (`project.read`), a person and an agent
 * alike, so a credential fenced to the issue's project reads the sibling requirement its issue
 * delivers. The text leaves under the requirement's own project's data policy.
 */

import { Hono } from 'hono';
import {
  issueRouteIdParamSchema,
  projectScopeQuery,
  resolveIssueRouteRef,
} from '../issues/index.js';
import { egressForRequest } from '../lib/data-egress.js';
import { assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { issueRequirementOf } from './issue-requirement-read.js';
import type { RequirementEnv } from './route-kit.js';

export const issueRequirementRoutes = new Hono<RequirementEnv>();

issueRequirementRoutes.use('/:id/requirement', requireAuth(), assertEmailVerified());

issueRequirementRoutes.get(
  '/:id/requirement',
  zValidator('param', issueRouteIdParamSchema),
  projectScopeQuery,
  async (c) => {
    const { id } = c.req.valid('param');
    const { projectId } = c.req.valid('query');
    const issue = await resolveIssueRouteRef(id, projectId, c.get('userId'));
    const read = await issueRequirementOf(issue.id);
    if (!read.requirement) return c.json(read);
    return c.json(
      await egressForRequest(
        c.get('agency'),
        read.requirement.project.id,
        'requirement',
        read,
        `${read.requirement.displayKey}, the requirement of issue ${issue.id}`,
      ),
    );
  },
);
