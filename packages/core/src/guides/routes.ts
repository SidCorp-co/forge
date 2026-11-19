import { CARD_AUDIENCES } from '@forge/contracts/capability-cards';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { cardText, doorCatalog } from '../lib/door-catalog.js';
import { env } from '../lib/env.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { noQuery, zValidator } from '../middleware/zod-validator.js';
import { requiresOnParam, requiresPublic } from '../permissions/index.js';
import { findProjectOrgId } from '../projects/index.js';
import { resolveGuide } from './integration-guides.js';
import { getGuide, listGuides } from './registry.js';
import {
  audienceMapPage,
  doorNamed,
  doorsPage,
  guideIndexBody,
  servedGuideBody,
} from './served.js';

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

const GUIDE_CORPUS = requiresPublic(
  'the guide corpus is the code’s own, with no tenant data, read by any client with no credential',
);
/** A project member reads a guide as its org shadows it: an org's integration guide over the code default. */
const projectGuideRoutes = new Hono<{ Variables: AuthVars }>();
// the gate covers the one path this router serves: it is mounted under /api/projects, so a `'*'`
// gate here ran on every project route that reached it and 401'd any unauthenticated one (ISS-925)
projectGuideRoutes.use('/:id/guides/:slug', requireAuth());

projectGuideRoutes.get(
  '/:id/guides/:slug',
  requiresOnParam('project.read', 'id'),
  noQuery,
  async (c) => {
    const projectId = c.req.param('id');
    const raw = c.req.param('slug');
    const isMarkdown = raw.endsWith('.md');
    const guide = await resolveGuide(
      isMarkdown ? raw.slice(0, -3) : raw,
      await findProjectOrgId(projectId),
    );
    if (!guide) {
      throw new HTTPException(404, { message: validSlugsMessage(), cause: { code: 'NOT_FOUND' } });
    }
    const body = servedGuideBody(guide);
    if (isMarkdown) {
      return c.body(body, 200, { 'content-type': 'text/markdown; charset=utf-8' });
    }
    return c.json({ guide: { ...guide, body } });
  },
);

guideRoutes.route('/projects', projectGuideRoutes);

/** The readable rendering of this same corpus, on the web host. */
function humanGuidesUrl(): string {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/guides`;
}

const GUIDE_INDEX = {
  slug: 'index',
  audience: 'agent',
  title: 'Forge guides',
  summary: 'Every guide core serves, by slug, title and summary.',
  version: 1,
} as const;

function validSlugsMessage(): string {
  const slugs = listGuides()
    .map((g) => g.slug)
    .join(', ');
  return `guide not found. The list: GET /api/guides (or guides/index.md). Valid slugs: ${slugs}. Readable pages: ${humanGuidesUrl()}`;
}

guideRoutes.get('/guides', GUIDE_CORPUS, noQuery, (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({ guides: listGuides() });
});

guideRoutes.get('/llms.txt', GUIDE_CORPUS, noQuery, (c) => {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto === 'https' || proto === 'http') url.protocol = `${proto}:`;
  const base = `${url.origin}${url.pathname.replace(/\/llms\.txt$/, '')}`;
  // the contracts are served under /api only, whichever of the two mounts answered this
  const api = base.endsWith('/api') ? base : `${base}/api`;
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
    '## API contract',
    '',
    `- [OpenAPI 3.1](${api}/openapi.json): every route core mounts, versioned by semver.`,
    `- [MCP tools](${api}/mcp-tools.json): the tools \`POST /mcp\` serves, versioned by semver.`,
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

/**
 * Every door by the situation that calls for it, one door's card (`?door=`), or one audience's Tier-0
 * map (`?audience=`, the master skill's map), rendered from the cards (ISS-1251): the page a run's
 * map points at before a door's first use.
 */
guideRoutes.get(
  '/guides/doors.md',
  GUIDE_CORPUS,
  zValidator(
    'query',
    z
      .strictObject({
        door: z.string().trim().min(3).max(300).optional(),
        audience: z.enum(CARD_AUDIENCES).optional(),
      })
      .refine((q) => !(q.door && q.audience), {
        message: 'name one door or one audience, never both',
      }),
  ),
  (c) => {
    const { door, audience } = c.req.valid('query');
    const catalog = doorCatalog();
    c.header('Cache-Control', 'public, max-age=300');
    const md = { 'content-type': 'text/markdown; charset=utf-8' };
    if (audience) return c.body(audienceMapPage(catalog, audience), 200, md);
    if (!door) return c.body(doorsPage(catalog), 200, md);
    const found = doorNamed(catalog, door);
    if (!found) {
      throw new HTTPException(404, {
        message: `${door} is no door Forge serves: name an MCP action (\`feedback.door\`) or a REST write as the contract lists it (\`POST /api/projects/:id/feedback\`); every door: guides/doors.md`,
        cause: { code: 'NOT_FOUND' },
      });
    }
    return c.body(`${cardText(found, 1)}\n`, 200, md);
  },
);

// Hono routes `:slug` as a literal path segment — it will NOT split
// `deploy-safety.md` into a separate `.md` route. Strip the suffix inside
// this one handler instead and switch the response shape/content-type.
guideRoutes.get('/guides/:slug', GUIDE_CORPUS, noQuery, (c) => {
  const raw = c.req.param('slug');
  const isMarkdown = raw.endsWith('.md');
  const slug = isMarkdown ? raw.slice(0, -3) : raw;

  // `index` is the list (ISS-1307), the name the MCP reads it by, served as a body like any guide
  const guide =
    slug === GUIDE_INDEX.slug
      ? { ...GUIDE_INDEX, body: guideIndexBody(listGuides()) }
      : getGuide(slug);
  if (!guide) {
    throw new HTTPException(404, {
      message: validSlugsMessage(),
      cause: { code: 'NOT_FOUND' },
    });
  }

  c.header('Cache-Control', 'public, max-age=300');
  const body = servedGuideBody(guide);
  if (isMarkdown) {
    return c.body(body, 200, { 'content-type': 'text/markdown; charset=utf-8' });
  }
  return c.json({ guide: { ...guide, body } });
});
