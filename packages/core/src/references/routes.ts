// The REST door of a project's reference sources (ISS-1252): read and search them, add one, propose
// one an agent kept using, change or remove one, cite one, read their signals and a source's
// timeline, and read a followed source's releases now. Each route validates, calls one function, and
// answers.

import {
  REFERENCE_ADD_SHAPE,
  REFERENCE_CITE_SHAPE,
  REFERENCE_PROPOSE_SHAPE,
  REFERENCE_REMOVE_SHAPE,
  REFERENCE_UPDATE_SHAPE,
  referenceAddRequestSchema,
  referenceCiteRequestSchema,
  referenceProposeRequestSchema,
  referenceRemoveRequestSchema,
  referenceSearchQuerySchema,
  referenceUpdateRequestSchema,
} from '@forge/contracts/references';
import { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam } from '../permissions/index.js';
import { followNow } from './follow.js';
import { searchSources, timelineOf } from './read.js';
import { addSource, citeSource, proposeSource, removeSource, updateSource } from './service.js';
import { referenceSignals } from './signals.js';

export const referenceSourceRoutes = new Hono<{ Variables: AuthVars }>();

for (const path of ['/:id/reference-sources', '/:id/reference-sources/*']) {
  referenceSourceRoutes.use(path, requireAuth(), assertEmailVerified());
}

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: /api/projects/<project uuid>/reference-sources'),
);
const sourceParam = zValidator(
  'param',
  z.object({ id: z.uuid(), source: z.string().trim().min(1).max(500) }),
  invalid(
    'invalid path: /api/projects/<project uuid>/reference-sources/<source id, address or name, url-encoded>',
  ),
);

const actorOf = (c: Parameters<typeof restActor>[0]) => {
  const a = restActor(c);
  return { userId: a.id, agency: a.agency };
};

referenceSourceRoutes.get(
  '/:id/reference-sources',
  projectParam,
  requiresOnParam('project.read', 'id'),
  zValidator(
    'query',
    referenceSearchQuerySchema,
    invalid('invalid query: ?area=<area>&q=<words>, both optional'),
  ),
  async (c) =>
    c.json({ sources: await searchSources(c.req.valid('param').id, c.req.valid('query')) }),
);

referenceSourceRoutes.get(
  '/:id/reference-sources/signals',
  projectParam,
  requiresOnParam('project.read', 'id'),
  noQuery,
  async (c) => c.json(await referenceSignals(c.req.valid('param').id)),
);

referenceSourceRoutes.post(
  '/:id/reference-sources',
  projectParam,
  requiresOnParam('project.write', 'id'),
  strictBody(referenceAddRequestSchema, REFERENCE_ADD_SHAPE),
  async (c) => {
    const out = await addSource({
      projectId: c.req.valid('param').id,
      actor: actorOf(c),
      request: c.req.valid('json'),
    });
    return out.ok ? c.json(out, 201) : refused(c, out.refusals, 'REFERENCE_REFUSED');
  },
);

referenceSourceRoutes.post(
  '/:id/reference-sources/propose',
  projectParam,
  requiresOnParam('project.write', 'id'),
  strictBody(referenceProposeRequestSchema, REFERENCE_PROPOSE_SHAPE),
  async (c) => {
    const out = await proposeSource({
      projectId: c.req.valid('param').id,
      actor: actorOf(c),
      request: c.req.valid('json'),
    });
    return out.ok ? c.json(out, 201) : refused(c, out.refusals, 'REFERENCE_REFUSED');
  },
);

referenceSourceRoutes.patch(
  '/:id/reference-sources/:source',
  sourceParam,
  requiresOnParam('project.write', 'id'),
  strictBody(referenceUpdateRequestSchema, REFERENCE_UPDATE_SHAPE),
  async (c) => {
    const { id, source } = c.req.valid('param');
    const out = await updateSource({
      projectId: id,
      actor: actorOf(c),
      ref: source,
      request: c.req.valid('json'),
    });
    return out.ok ? c.json(out) : refused(c, out.refusals, 'REFERENCE_REFUSED');
  },
);

referenceSourceRoutes.post(
  '/:id/reference-sources/:source/remove',
  sourceParam,
  requiresOnParam('project.write', 'id'),
  strictBody(referenceRemoveRequestSchema, REFERENCE_REMOVE_SHAPE),
  async (c) => {
    const { id, source } = c.req.valid('param');
    const out = await removeSource({
      projectId: id,
      actor: actorOf(c),
      ref: source,
      reason: c.req.valid('json').reason,
    });
    return out.ok ? c.json(out) : refused(c, out.refusals, 'REFERENCE_REFUSED');
  },
);

referenceSourceRoutes.post(
  '/:id/reference-sources/:source/citations',
  sourceParam,
  requiresOnParam('project.write', 'id'),
  strictBody(referenceCiteRequestSchema, REFERENCE_CITE_SHAPE),
  async (c) => {
    const { id, source } = c.req.valid('param');
    const out = await citeSource({
      projectId: id,
      actor: actorOf(c),
      ref: source,
      request: c.req.valid('json'),
    });
    return c.json(out, 201);
  },
);

referenceSourceRoutes.get(
  '/:id/reference-sources/:source/timeline',
  sourceParam,
  requiresOnParam('project.read', 'id'),
  noQuery,
  async (c) => {
    const { id, source } = c.req.valid('param');
    return c.json(await timelineOf(id, source));
  },
);

referenceSourceRoutes.post(
  '/:id/reference-sources/:source/follow',
  sourceParam,
  requiresOnParam('project.write', 'id'),
  strictBody(z.strictObject({}), '{} (no fields)'),
  async (c) => {
    const { id, source } = c.req.valid('param');
    return c.json(await followNow(id, source));
  },
);
