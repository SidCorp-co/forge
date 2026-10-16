import { Hono } from 'hono';
import { z } from 'zod';
import { heldIssuePrefixes } from '../issues/index.js';
import { egressForRequest } from '../lib/data-egress.js';
import { issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { badRequest, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { readFeedbackForecasts } from './feedback.js';
import { readIssueForecast, readProjectForecast } from './read.js';
import {
  readComingNext,
  readDraftReleaseForecast,
  readRequirementForecast,
  readRequirementForecasts,
} from './scope.js';
import { forecastViewerOf } from './viewer.js';

const projectParam = z.object({ id: z.uuid() });
const issueParam = z.object({
  id: z.uuid(),
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,5}-\d+$/),
});
const requirementParam = z.object({ id: z.uuid(), key: z.string().regex(/^REQ-\d+$/) });
const noQuery = z.strictObject({});

export const forecastRoutes = new Hono<{ Variables: AuthVars }>();
forecastRoutes.use('*', requireAuth(), assertEmailVerified());

forecastRoutes.get(
  '/:id/forecast',
  zValidator('param', projectParam),
  zValidator('query', noQuery),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const viewer = await forecastViewerOf(projectId, c.get('userId'));
    const read = await readProjectForecast(projectId, viewer);
    return c.json(
      await egressForRequest(restActor(c).agency, projectId, 'issue', read, 'the forecast'),
    );
  },
);

forecastRoutes.get(
  '/:id/forecast/issues/:key',
  zValidator('param', issueParam),
  zValidator('query', noQuery),
  async (c) => {
    const { id: projectId, key } = c.req.valid('param');
    const viewer = await forecastViewerOf(projectId, c.get('userId'));
    const parsed = parseIssueRef(
      key,
      issueRefNeedsHeldPrefixes(key) ? await heldIssuePrefixes(projectId) : [],
    );
    if (!parsed.ok) throw badRequest(parsed.message);
    const read = await readIssueForecast(projectId, parsed.issSeq, viewer);
    if (!read) throw notFound(`issue ${key} not found in this project`);
    return c.json(await egressForRequest(restActor(c).agency, projectId, 'issue', read, key));
  },
);

forecastRoutes.get(
  '/:id/forecast/requirements',
  zValidator('param', projectParam),
  zValidator('query', noQuery),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const viewer = await forecastViewerOf(projectId, c.get('userId'));
    const read = await readRequirementForecasts(projectId, viewer);
    return c.json(
      await egressForRequest(
        restActor(c).agency,
        projectId,
        'issue',
        read,
        'the requirements forecast',
      ),
    );
  },
);

forecastRoutes.get(
  '/:id/forecast/feedback',
  zValidator('param', projectParam),
  zValidator('query', noQuery),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const viewer = await forecastViewerOf(projectId, c.get('userId'));
    const actor = restActor(c);
    const read = await readFeedbackForecasts(
      { userId: c.get('userId'), agency: actor.agency },
      projectId,
      viewer,
    );
    return c.json(
      await egressForRequest(actor.agency, projectId, 'issue', read, 'the feedback forecast'),
    );
  },
);

forecastRoutes.get(
  '/:id/forecast/releases/coming',
  zValidator('param', projectParam),
  zValidator('query', noQuery),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const viewer = await forecastViewerOf(projectId, c.get('userId'));
    const read = await readComingNext(projectId, viewer);
    return c.json(
      await egressForRequest(restActor(c).agency, projectId, 'issue', read, 'what comes next'),
    );
  },
);

forecastRoutes.get(
  '/:id/forecast/requirements/:key',
  zValidator('param', requirementParam),
  zValidator('query', noQuery),
  async (c) => {
    const { id: projectId, key } = c.req.valid('param');
    const viewer = await forecastViewerOf(projectId, c.get('userId'));
    const read = await readRequirementForecast(projectId, Number(key.slice('REQ-'.length)), viewer);
    if (!read) throw notFound(`requirement ${key} not found in this project`);
    return c.json(await egressForRequest(restActor(c).agency, projectId, 'issue', read, key));
  },
);

forecastRoutes.get(
  '/:id/forecast/releases/draft',
  zValidator('param', projectParam),
  zValidator('query', noQuery),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const viewer = await forecastViewerOf(projectId, c.get('userId'));
    const read = await readDraftReleaseForecast(projectId, viewer);
    return c.json(
      await egressForRequest(restActor(c).agency, projectId, 'issue', read, 'the draft release'),
    );
  },
);
