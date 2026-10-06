import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { loadProjectAccess } from '../lib/authz.js';
import { env } from '../lib/env.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { requireHeld } from '../permissions/index.js';
import { findProjectOrgId } from '../projects/index.js';
import { resolveGuide } from './integration-guides.js';
import { getGuide, listGuides } from './registry.js';

/**
 * Public, read-only surface for Forge capability guides (D2 in the plan —
 * no tenant data, no secrets, deliberately unauthenticated so `WebFetch` /
 * browser / docs-site clients and agents all read the same bytes).
 * The `/guides` and `/llms.txt` routes take no `requireAuth` and no membership check, by design.
 *
 * Mounted at BOTH the core root and `/api` in `index.ts`, mirroring
 * `installRoutes`: the hosted edge proxy forwards only `/api/*` to core, so
 * every pointer we emit elsewhere in the product MUST use the `/api/guides`
 * form; the root mount exists for self-hosters exposing core directly.
 *
 * The one exception is `/projects/:id/guides/:slug` below: it reads a guide as the
 * project's org shadows it, so it is authenticated and needs `project.read`.
 */
export const guideRoutes = new Hono();
/** A project member reads a guide as its org shadows it: an org's integration guide over the code default. */
const projectGuideRoutes = new Hono<{ Variables: AuthVars }>();
projectGuideRoutes.use('*', requireAuth());

projectGuideRoutes.get('/:id/guides/:slug', async (c) => {
  const projectId = c.req.param('id');
  requireHeld(await loadProjectAccess(projectId, c.get('userId')), 'project.read');
  const raw = c.req.param('slug');
  const isMarkdown = raw.endsWith('.md');
  const guide = await resolveGuide(
    isMarkdown ? raw.slice(0, -3) : raw,
    await findProjectOrgId(projectId),
  );
  if (!guide) {
    throw new HTTPException(404, { message: validSlugsMessage(), cause: { code: 'NOT_FOUND' } });
  }
  if (isMarkdown) {
    return c.body(guide.body, 200, { 'content-type': 'text/markdown; charset=utf-8' });
  }
  return c.json({ guide });
});

guideRoutes.route('/projects', projectGuideRoutes);

/** The readable rendering of this same corpus, on the web host. */
function humanGuidesUrl(): string {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/guides`;
}

function validSlugsMessage(): string {
  const slugs = listGuides()
    .map((g) => g.slug)
    .join(', ');
  return `guide not found. Valid slugs: ${slugs}. Readable pages: ${humanGuidesUrl()}`;
}

guideRoutes.get('/guides', (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ guides: listGuides() });
});

guideRoutes.get('/llms.txt', (c) => {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`;
  const base = `${url.origin}${url.pathname.replace(/\/llms\.txt$/, '')}`;
  const lines = [
    '# Forge',
    '',
    '> Open-source control plane for Claude Code: full-stack project management plus an agent',
    '> pipeline that drives Claude end to end (triage → clarify → plan → code → review → test →',
    '> release). Every URL below is unauthenticated and returns raw markdown — fetch what you',
    '> need, when you need it.',
    '>',
    `> A person reads the same corpus as web pages at ${humanGuidesUrl()} — also no credential.`,
    '',
    '## Guides',
    '',
    ...listGuides().map((g) => `- [${g.title}](${base}/guides/${g.slug}.md): ${g.summary}`),
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
