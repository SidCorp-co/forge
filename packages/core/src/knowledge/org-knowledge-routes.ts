// The doors of an organisation's own knowledge (ISS-861), `/api/orgs/:orgId/knowledge/:slug`, org
// admin: GET, PUT (create or replace) and DELETE, each refusing an entry the org does not hold by name.

import {
  ORG_KNOWLEDGE_SLUG,
  ORG_KNOWLEDGE_SLUG_MAX,
  ORG_KNOWLEDGE_WRITE_SHAPE,
  orgKnowledgeWriteSchema,
} from '@forge/contracts/org-knowledge';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { actorFor, orgResource, requireOrgCan } from '../permissions/index.js';
import {
  deleteOrgKnowledge,
  orgKnowledgeEntryOf,
  orgKnowledgeOf,
  writeOrgKnowledge,
} from './org-knowledge.js';

const notFound = (orgId: string, slug: string) =>
  new HTTPException(404, {
    message: `organisation ${orgId} holds no knowledge entry "${slug}"; GET /api/orgs/${orgId}/knowledge lists the ones it holds`,
    cause: { code: 'ORG_KNOWLEDGE_NOT_FOUND' },
  });

const orgParam = zValidator(
  'param',
  z.object({ orgId: z.uuid() }),
  invalid('invalid path: the org id is a uuid'),
);
const entryParam = zValidator(
  'param',
  z.object({
    orgId: z.uuid(),
    slug: z.string().min(1).max(ORG_KNOWLEDGE_SLUG_MAX).regex(ORG_KNOWLEDGE_SLUG),
  }),
  invalid(
    `invalid path: /api/orgs/<org uuid>/knowledge/<slug>, the slug kebab-case, 1-${ORG_KNOWLEDGE_SLUG_MAX} characters`,
    'ORG_KNOWLEDGE_SLUG_INVALID',
  ),
);

export const orgKnowledgeRoutes = new Hono<{ Variables: AuthVars }>();
orgKnowledgeRoutes.use('/:orgId/knowledge', requireAuth(), assertEmailVerified());
orgKnowledgeRoutes.use('/:orgId/knowledge/*', requireAuth(), assertEmailVerified());

orgKnowledgeRoutes.get('/:orgId/knowledge', orgParam, noQuery, async (c) => {
  const { orgId } = c.req.valid('param');
  await requireOrgCan(actorFor(c.get('userId')), 'org.admin', orgResource(orgId));
  return c.json({ entries: await orgKnowledgeOf(orgId) });
});

orgKnowledgeRoutes.get('/:orgId/knowledge/:slug', entryParam, noQuery, async (c) => {
  const { orgId, slug } = c.req.valid('param');
  await requireOrgCan(actorFor(c.get('userId')), 'org.admin', orgResource(orgId));
  const entry = await orgKnowledgeEntryOf(orgId, slug);
  if (!entry) throw notFound(orgId, slug);
  return c.json(entry);
});

orgKnowledgeRoutes.put(
  '/:orgId/knowledge/:slug',
  entryParam,
  strictBody(orgKnowledgeWriteSchema, ORG_KNOWLEDGE_WRITE_SHAPE),
  async (c) => {
    const { orgId, slug } = c.req.valid('param');
    const userId = c.get('userId');
    await requireOrgCan(actorFor(userId), 'org.admin', orgResource(orgId));
    return c.json(await writeOrgKnowledge(orgId, slug, c.req.valid('json'), userId));
  },
);

orgKnowledgeRoutes.delete('/:orgId/knowledge/:slug', entryParam, noQuery, async (c) => {
  const { orgId, slug } = c.req.valid('param');
  await requireOrgCan(actorFor(c.get('userId')), 'org.admin', orgResource(orgId));
  if (!(await deleteOrgKnowledge(orgId, slug))) throw notFound(orgId, slug);
  return c.json({ deleted: slug });
});
