import { ALWAYS_INJECT_GUARANTEE_NOTE, ALWAYS_INJECT_MAX_CHARS } from '@forge/contracts/knowledge';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { issueStatuses } from '../db/schema.js';
import { masterVerbs } from '../db/schema-master-charter.js';
import { RULES } from '../lib/rate-limits.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import {
  knowledgeInjectionEnum,
  knowledgeKindEnum,
  slugSchema,
  upsertKnowledgeInputSchema,
} from './entry-input.js';
import { deleteKnowledgeEntry, getKnowledgeEntry, listKnowledgeEntries } from './service.js';
import { runUnifiedSearch } from './unified-search.js';
import { upsertKnowledgeEntry } from './upsert.js';

const idParamSchema = z.object({ id: z.uuid() });
/**
 * The slug is validated here rather than only on the way to the database, and
 * every route below matches it as `:slug{.+}` so that a slug carrying a slash
 * REACHES this schema. Matched as a single path segment, `convention/some-rule`
 * matched no route at all and came back as a bare routing 404 — which reads as
 * "there is no such entry" when the truth is "that is not a slug", and sent at
 * least one run off to file a defect against a store that was behaving. A wrong
 * input is refused by name, with the rule it broke.
 */
const slugParamSchema = z.object({ id: z.uuid(), slug: slugSchema });

const listQuerySchema = z.object({
  kind: z.enum(knowledgeKindEnum).optional(),
  injection: z.enum(knowledgeInjectionEnum).optional(),
  // Left as bare strings rather than a zod enum so a bad value is refused with the message below
  // — naming the field and every value that IS valid — rather than zValidator's generic
  // "invalid query params" (ISS-1313 criteria 24, 25).
  verb: z.string().optional(),
  status: z.string().optional(),
});

const badRequest = (message: string) => new HTTPException(400, { message });

function parseVerbQuery(raw: string | undefined): (typeof masterVerbs)[number] | undefined {
  if (raw === undefined) return undefined;
  if (!(masterVerbs as readonly string[]).includes(raw)) {
    throw badRequest(
      `\`verb\` names "${raw}", which is not a verb a master performs. Valid verbs: ${masterVerbs.join(', ')}.`,
    );
  }
  return raw as (typeof masterVerbs)[number];
}

function parseStatusQuery(raw: string | undefined): (typeof issueStatuses)[number] | undefined {
  if (raw === undefined) return undefined;
  if (!(issueStatuses as readonly string[]).includes(raw)) {
    throw badRequest(
      `\`status\` names "${raw}", which is not an issue status. Valid statuses: ${issueStatuses.join(', ')}.`,
    );
  }
  return raw as (typeof issueStatuses)[number];
}
const badSlug = (slug: string) =>
  badRequest(
    `"${slug}" is not a knowledge slug: a slug is kebab-case — lower-case letters and digits separated by hyphens, starting with a letter or digit, at most 512 characters — and carries no slash, so there are no nested slugs. A path like "convention/my-rule" is not an entry that is hard to reach, it is a name this store cannot hold; write it as "convention-my-rule". Memory documents DO carry slash-separated source refs and are a different store, reached through /api/memory rather than /api/projects/:id/knowledge.`,
  );
const notFound = () => new HTTPException(404, { message: 'knowledge entry not found' });

export const knowledgeRoutes = new Hono<{ Variables: AuthVars }>();
knowledgeRoutes.use('*', requireAuth(), assertEmailVerified());

knowledgeRoutes.get(
  '/:id/knowledge',
  zValidator('param', idParamSchema, invalid('invalid project id')),
  zValidator('query', listQuerySchema, invalid('invalid query params')),
  async (c) => {
    const { id } = c.req.valid('param');
    const { kind, injection, verb: verbRaw, status: statusRaw } = c.req.valid('query');
    const verb = parseVerbQuery(verbRaw);
    const status = parseStatusQuery(statusRaw);
    const userId = c.get('userId');
    await requireCan(actorFor(userId), 'project.read', projectResource(id));

    const result = await listKnowledgeEntries({ projectId: id, kind, injection, verb, status });
    return c.json({
      ...result,
      maxAlwaysInjectChars: ALWAYS_INJECT_MAX_CHARS,
      alwaysInjectGuarantee: ALWAYS_INJECT_GUARANTEE_NOTE,
    });
  },
);

const searchBodySchema = z.object({
  query: z.string().trim().min(1).max(4000),
  scope: z.enum(['knowledge', 'memory', 'all']).default('knowledge'),
  topK: z.number().int().min(1).max(50).default(10),
  strategy: z.enum(['semantic', 'keyword', 'hybrid']).default('semantic'),
});

knowledgeRoutes.post(
  '/:id/knowledge/search',
  rateLimit(() => RULES.knowledgeSearch, { name: 'knowledge-search' }),
  zValidator('param', idParamSchema, invalid('invalid project id')),
  zValidator('json', searchBodySchema, invalid('invalid body')),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await requireCan(actorFor(userId), 'project.read', projectResource(id));

    return c.json(await runUnifiedSearch({ projectId: id, ...body }));
  },
);

knowledgeRoutes.get(
  '/:id/knowledge/:slug{.+}',
  zValidator('param', slugParamSchema, (r, c) => {
    if (!r.success) throw badSlug(c.req.param('slug') ?? '');
  }),
  async (c) => {
    const { id, slug } = c.req.valid('param');
    const userId = c.get('userId');
    await requireCan(actorFor(userId), 'project.read', projectResource(id));

    const entry = await getKnowledgeEntry(id, slug);
    if (!entry) throw notFound();
    return c.json(entry);
  },
);

const upsertBodySchema = upsertKnowledgeInputSchema.omit({ projectId: true, slug: true });

knowledgeRoutes.put(
  '/:id/knowledge/:slug{.+}',
  zValidator('param', slugParamSchema, (r, c) => {
    if (!r.success) throw badSlug(c.req.param('slug') ?? '');
  }),
  zValidator('json', upsertBodySchema, invalid('invalid body')),
  async (c) => {
    const { id, slug } = c.req.valid('param');
    const body = c.req.valid('json');
    const userId = c.get('userId');
    await requireCan(actorFor(userId), 'project.write', projectResource(id));

    return c.json(await upsertKnowledgeEntry({ projectId: id, slug, ...body }));
  },
);

knowledgeRoutes.delete(
  '/:id/knowledge/:slug{.+}',
  zValidator('param', slugParamSchema, (r, c) => {
    if (!r.success) throw badSlug(c.req.param('slug') ?? '');
  }),
  async (c) => {
    const { id, slug } = c.req.valid('param');
    const userId = c.get('userId');
    await requireCan(actorFor(userId), 'project.write', projectResource(id));

    const removed = await deleteKnowledgeEntry(id, slug);
    return c.json({ deleted: removed > 0 });
  },
);
