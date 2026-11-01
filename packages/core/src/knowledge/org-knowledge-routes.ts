// The doors of an organisation's own knowledge (ISS-861), `/api/orgs/:orgId/knowledge/:slug`, org
// admin: GET, PUT (create or replace) and DELETE, each refusing an entry the org does not hold by name.

import {
  ORG_KNOWLEDGE_SLUG,
  ORG_KNOWLEDGE_SLUG_MAX,
  ORG_KNOWLEDGE_WRITE_SHAPE,
  type OrgKnowledgeEntry,
  orgKnowledgeWriteSchema,
} from '@forge/contracts/org-knowledge';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { orgKnowledgeEntries } from '../db/schema.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { actorFor, orgResource, requireOrgCan } from '../permissions/index.js';

type Row = typeof orgKnowledgeEntries.$inferSelect;

const viewOf = (r: Row): OrgKnowledgeEntry => ({
  orgId: r.orgId,
  slug: r.slug,
  title: r.title,
  body: r.body,
  injection: r.injection,
  orderIndex: r.orderIndex,
  updatedBy: r.updatedBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

async function entryOf(orgId: string, slug: string): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(orgKnowledgeEntries)
    .where(and(eq(orgKnowledgeEntries.orgId, orgId), eq(orgKnowledgeEntries.slug, slug)))
    .limit(1);
  return row ?? null;
}

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
  const rows = await db
    .select()
    .from(orgKnowledgeEntries)
    .where(eq(orgKnowledgeEntries.orgId, orgId))
    .orderBy(asc(orgKnowledgeEntries.orderIndex), asc(orgKnowledgeEntries.slug));
  return c.json({ entries: rows.map(viewOf) });
});

orgKnowledgeRoutes.get('/:orgId/knowledge/:slug', entryParam, noQuery, async (c) => {
  const { orgId, slug } = c.req.valid('param');
  await requireOrgCan(actorFor(c.get('userId')), 'org.admin', orgResource(orgId));
  const row = await entryOf(orgId, slug);
  if (!row) throw notFound(orgId, slug);
  return c.json(viewOf(row));
});

orgKnowledgeRoutes.put(
  '/:orgId/knowledge/:slug',
  entryParam,
  strictBody(orgKnowledgeWriteSchema, ORG_KNOWLEDGE_WRITE_SHAPE),
  async (c) => {
    const { orgId, slug } = c.req.valid('param');
    const userId = c.get('userId');
    await requireOrgCan(actorFor(userId), 'org.admin', orgResource(orgId));
    const write = c.req.valid('json');
    const now = new Date();
    const [row] = await db
      .insert(orgKnowledgeEntries)
      .values({ orgId, slug, ...write, updatedBy: userId, updatedAt: now })
      .onConflictDoUpdate({
        target: [orgKnowledgeEntries.orgId, orgKnowledgeEntries.slug],
        set: { ...write, updatedBy: userId, updatedAt: now },
      })
      .returning();
    if (!row) throw new Error('org knowledge: the upsert returned no row');
    return c.json(viewOf(row));
  },
);

orgKnowledgeRoutes.delete('/:orgId/knowledge/:slug', entryParam, noQuery, async (c) => {
  const { orgId, slug } = c.req.valid('param');
  await requireOrgCan(actorFor(c.get('userId')), 'org.admin', orgResource(orgId));
  const removed = await db
    .delete(orgKnowledgeEntries)
    .where(and(eq(orgKnowledgeEntries.orgId, orgId), eq(orgKnowledgeEntries.slug, slug)))
    .returning({ slug: orgKnowledgeEntries.slug });
  if (removed.length === 0) throw notFound(orgId, slug);
  return c.json({ deleted: slug });
});
