import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { declaresInput, zValidator } from '../api-reference/declare/validator.js';
import { env } from '../config/env.js';
import { INTEGRATION_PROVIDERS } from '../integrations/types.js';
import { loadOrgRole, orgRoleAtLeast } from '../lib/authz.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import {
  CORPUS_SCOPE,
  cliServedBullets,
  corpusScopeSentence,
  NOT_SERVED_HERE_NOTE,
} from './corpus-scope.js';
import {
  deleteIntegrationGuide,
  integrationGuideSlug,
  resolveGuide,
  resolveGuideIndex,
  upsertIntegrationGuide,
} from './integration-guides.js';
import { getGuide, listGuides } from './registry.js';
import {
  deletedGuideSchema,
  deleteIntegrationGuideOp,
  guideEnvelopeSchema,
  guideIndexSchema,
  guideSlugParamSchema,
  listGuideIndex,
  listOrgGuides,
  orgGuideIndexSchema,
  orgGuideParamSchema,
  orgGuideSlugParamSchema,
  orgProviderParamSchema,
  putIntegrationGuide,
  readGuide,
  readLlmsTxt,
  readOrgGuide,
  storedGuideSchema,
  upsertGuideSchema,
} from './routes-reference.js';

/**
 * Public, read-only surface for Forge capability guides (D2 in the plan —
 * no tenant data, no secrets, deliberately unauthenticated so `WebFetch` /
 * browser / docs-site clients can read the same bytes `forge_guide` returns).
 * No `requireAuth`, no project-membership check — by design.
 *
 * Mounted at BOTH the core root and `/api` in `index.ts`, mirroring
 * `installRoutes`: the hosted edge proxy forwards only `/api/*` to core, so
 * every pointer we emit elsewhere in the product MUST use the `/api/guides`
 * form; the root mount exists for self-hosters exposing core directly.
 *
 * The `/orgs/:orgId/integration-guides` sub-tree below is the write tier and is
 * separately authenticated.
 */
export const guideRoutes = new Hono();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const orgGuideRoutes = new Hono<{ Variables: AuthVars }>();
orgGuideRoutes.use('*', requireAuth());

async function assertOrgAdmin(orgId: string, userId: string): Promise<void> {
  const role = await loadOrgRole(orgId, userId);
  if (!orgRoleAtLeast(role, 'admin')) {
    throw new HTTPException(403, {
      message: 'org admin or owner required',
      cause: { code: 'FORBIDDEN' },
    });
  }
}

function assertKnownProvider(provider: string): void {
  if (!INTEGRATION_PROVIDERS.includes(provider as (typeof INTEGRATION_PROVIDERS)[number])) {
    throw new HTTPException(400, {
      message: `unknown integration provider '${provider}'. Known: ${INTEGRATION_PROVIDERS.join(', ')}`,
      cause: { code: 'BAD_REQUEST' },
    });
  }
}

orgGuideRoutes.get(
  '/:orgId/guides',
  listOrgGuides,
  zValidator('param', orgGuideParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    await assertOrgAdmin(orgId, c.get('userId'));
    return c.json(answer(orgGuideIndexSchema, { guides: await resolveGuideIndex(orgId) }));
  },
);

orgGuideRoutes.get(
  '/:orgId/guides/:slug',
  readOrgGuide,
  zValidator('param', orgGuideSlugParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { orgId, slug } = c.req.valid('param');
    await assertOrgAdmin(orgId, c.get('userId'));
    const guide = await resolveGuide(slug, orgId);
    if (!guide) {
      throw new HTTPException(404, { message: validSlugsMessage(), cause: { code: 'NOT_FOUND' } });
    }
    return c.json(answer(guideEnvelopeSchema, { guide }));
  },
);

orgGuideRoutes.put(
  '/:orgId/integration-guides/:provider',
  putIntegrationGuide,
  zValidator('param', orgProviderParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', upsertGuideSchema),
  async (c) => {
    const { orgId, provider } = c.req.valid('param');
    assertKnownProvider(provider);
    const userId = c.get('userId');
    await assertOrgAdmin(orgId, userId);
    const row = await upsertIntegrationGuide({
      orgId,
      provider: provider as (typeof INTEGRATION_PROVIDERS)[number],
      ...c.req.valid('json'),
      updatedBy: userId,
    });
    return c.json(
      answer(storedGuideSchema, {
        guide: {
          slug: integrationGuideSlug(row.provider),
          title: row.title,
          summary: row.summary,
          version: row.version,
          updatedAt: row.updatedAt,
        },
      }),
    );
  },
);

orgGuideRoutes.delete(
  '/:orgId/integration-guides/:provider',
  deleteIntegrationGuideOp,
  zValidator('param', orgProviderParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { orgId, provider } = c.req.valid('param');
    assertKnownProvider(provider);
    await assertOrgAdmin(orgId, c.get('userId'));
    return c.json(
      answer(deletedGuideSchema, { deleted: await deleteIntegrationGuide(orgId, provider) }),
    );
  },
);

guideRoutes.route('/orgs', orgGuideRoutes);

/** The readable rendering of this same corpus, on the web host. */
function humanGuidesUrl(): string {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/guides`;
}

function validSlugsMessage(): string {
  const slugs = listGuides()
    .map((g) => g.slug)
    .join(', ');
  return `guide not found. Valid slugs: ${slugs}. ${NOT_SERVED_HERE_NOTE} Readable pages: ${humanGuidesUrl()}`;
}

guideRoutes.get('/guides', listGuideIndex, (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(
    answer(guideIndexSchema, {
      guides: listGuides(),
      corpus: { ...CORPUS_SCOPE, cliServed: [...CORPUS_SCOPE.cliServed] },
    }),
  );
});

guideRoutes.get('/llms.txt', readLlmsTxt, (c) => {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`;
  const base = `${url.origin}${url.pathname.replace(/\/llms\.txt$/, '')}`;
  const lines = [
    '# Forge',
    '',
    '> Open-source control plane for Claude Code: full-stack project management plus an agent',
    '> pipeline in which one Claude run carries an issue end to end, from filed to shipped. These',
    '> guides are the same bytes the `forge_guide` MCP tool serves. Every URL below',
    '> is unauthenticated and returns raw markdown — fetch what you need, when you need it.',
    '>',
    `> A person reads the same corpus as web pages at ${humanGuidesUrl()} — also no credential.`,
    '>',
    `> ${corpusScopeSentence()}`,
    '',
    '## Guides',
    '',
    ...listGuides().map((g) => `- [${g.title}](${base}/guides/${g.slug}.md): ${g.summary}`),
    '',
    '## Method guides, served by the forge CLI and not by this host',
    '',
    CORPUS_SCOPE.authority,
    '',
    ...cliServedBullets(),
    '',
    '## Index',
    '',
    `- [Guide index (JSON)](${base}/guides): slug, title, summary and version for every guide.`,
    `- [Guide index (web pages)](${humanGuidesUrl()}): the same corpus a person can read.`,
    '',
  ];
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(lines.join('\n'), 200, { 'content-type': 'text/plain; charset=utf-8' });
});

// Hono routes `:slug` as a literal path segment — it will NOT split
// `deploy-safety.md` into a separate `.md` route. Strip the suffix inside
// this one handler instead and switch the response shape/content-type.
guideRoutes.get('/guides/:slug', readGuide, declaresInput('param', guideSlugParamSchema), (c) => {
  const raw = guideSlugParamSchema.parse(c.req.param()).slug;
  const isMarkdown = raw.endsWith('.md');
  const slug = isMarkdown ? raw.slice(0, -3) : raw;

  const guide = getGuide(slug);
  if (!guide) {
    throw new HTTPException(404, {
      message: validSlugsMessage(),
      cause: { code: 'NOT_FOUND' },
    });
  }

  c.header('Cache-Control', 'public, max-age=300');
  if (isMarkdown) {
    return c.body(guide.body, 200, { 'content-type': 'text/markdown; charset=utf-8' });
  }
  return c.json(answer(guideEnvelopeSchema, { guide }));
});
