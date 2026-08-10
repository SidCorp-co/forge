import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { INTEGRATION_PROVIDERS } from '../integrations/types.js';
import { loadOrgRole, orgRoleAtLeast } from '../lib/authz.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import {
  deleteIntegrationGuide,
  integrationGuideSlug,
  resolveGuide,
  resolveGuideIndex,
  upsertIntegrationGuide,
} from './integration-guides.js';
import { getGuide, listGuides } from './registry.js';

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

// cm:guard the two public GETs serve the CODE tier only — this router is unauthenticated, so layering an org's guide into them would publish tenant bytes to anyone who can guess an org id
const upsertSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(500),
  body: z.string().min(1).max(200000),
});

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

orgGuideRoutes.get('/:orgId/guides', async (c) => {
  const orgId = c.req.param('orgId');
  await assertOrgAdmin(orgId, c.get('userId'));
  return c.json({ guides: await resolveGuideIndex(orgId) });
});

orgGuideRoutes.get('/:orgId/guides/:slug', async (c) => {
  const orgId = c.req.param('orgId');
  await assertOrgAdmin(orgId, c.get('userId'));
  const guide = await resolveGuide(c.req.param('slug'), orgId);
  if (!guide) {
    throw new HTTPException(404, { message: validSlugsMessage(), cause: { code: 'NOT_FOUND' } });
  }
  return c.json({ guide });
});

orgGuideRoutes.put(
  '/:orgId/integration-guides/:provider',
  zValidator('json', upsertSchema),
  async (c) => {
    const orgId = c.req.param('orgId');
    const provider = c.req.param('provider');
    assertKnownProvider(provider);
    const userId = c.get('userId');
    await assertOrgAdmin(orgId, userId);
    const row = await upsertIntegrationGuide({
      orgId,
      provider: provider as (typeof INTEGRATION_PROVIDERS)[number],
      ...c.req.valid('json'),
      updatedBy: userId,
    });
    return c.json({
      guide: {
        slug: integrationGuideSlug(row.provider),
        title: row.title,
        summary: row.summary,
        version: row.version,
        updatedAt: row.updatedAt,
      },
    });
  },
);

orgGuideRoutes.delete('/:orgId/integration-guides/:provider', async (c) => {
  const orgId = c.req.param('orgId');
  const provider = c.req.param('provider');
  assertKnownProvider(provider);
  await assertOrgAdmin(orgId, c.get('userId'));
  return c.json({ deleted: await deleteIntegrationGuide(orgId, provider) });
});

guideRoutes.route('/orgs', orgGuideRoutes);

function validSlugsMessage(): string {
  const slugs = listGuides()
    .map((g) => g.slug)
    .join(', ');
  return `guide not found. Valid slugs: ${slugs}`;
}

guideRoutes.get('/guides', (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ guides: listGuides() });
});

// cm:guard emit every URL relative to THIS request's own mount prefix — the router is mounted at both `/` and `/api` and the hosted edge forwards only `/api/*`, so a hardcoded prefix publishes links that 404 for half the audience
// cm:why the /llms.txt convention is the entry point this surface lacked — /guides has been public since ISS-746, but a reader had to already know a slug, so nothing was discoverable from a bare hostname
guideRoutes.get('/llms.txt', (c) => {
  const base = c.req.url.replace(/\/llms\.txt(\?.*)?$/, '');
  const lines = [
    '# Forge',
    '',
    '> Open-source control plane for Claude Code: full-stack project management plus an agent',
    '> pipeline that drives Claude end to end (triage → clarify → plan → code → review → test →',
    '> release). These guides are the same bytes the `forge_guide` MCP tool serves. Every URL below',
    '> is unauthenticated and returns raw markdown — fetch what you need, when you need it.',
    '',
    '## Guides',
    '',
    ...listGuides().map((g) => `- [${g.title}](${base}/guides/${g.slug}.md): ${g.summary}`),
    '',
    '## Index',
    '',
    `- [Guide index (JSON)](${base}/guides): slug, title, summary and version for every guide.`,
    '',
  ];
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(lines.join('\n'), 200, { 'content-type': 'text/plain; charset=utf-8' });
});

// Hono routes `:slug` as a literal path segment — it will NOT split
// `deploy-safety.md` into a separate `.md` route. Strip the suffix inside
// this one handler instead and switch the response shape/content-type.
guideRoutes.get('/guides/:slug', (c) => {
  const raw = c.req.param('slug');
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
  return c.json({ guide });
});
