import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
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
 */
export const guideRoutes = new Hono();

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
