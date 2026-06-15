/**
 * Forge PLATFORM docs — the global `/docs` nav surface. Serves Forge's own
 * documentation (top-level `*.md` + the `docs/` tree) bundled WITH the
 * deployment, independent of any project. This is what HelpButton "Learn more"
 * deep-links (`/docs?path=docs/guides/…`) resolve against.
 *
 *   GET /api/docs                 — Forge's markdown file tree
 *   GET /api/docs/content?path=…  — one file's raw markdown
 *
 * Source root resolution (in order):
 *   1. env `FORGE_DOCS_ROOT` (set explicitly in a deploy if docs live elsewhere)
 *   2. the first of [cwd, cwd/../..] that actually contains a `docs/` dir —
 *      covers the prod image (cwd `/app`, docs COPY'd to `/app/docs`) AND local
 *      dev (cwd `packages/core`, repo root two levels up)
 *   3. cwd as a last resort (tree just renders empty if no docs are present)
 *
 * Read-only, any authenticated user — platform docs are not project-scoped.
 * Path containment / symlink-escape blocking lives in the shared `read.ts`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { buildDocsTree, readDocFile } from './read.js';

async function hasDocsDir(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(dir, 'docs'))).isDirectory();
  } catch {
    return false;
  }
}

let cachedRoot: string | null = null;

async function resolveDocsRoot(): Promise<string> {
  if (cachedRoot) return cachedRoot;

  const explicit = process.env.FORGE_DOCS_ROOT?.trim();
  const candidates = explicit
    ? [explicit]
    : [process.cwd(), path.resolve(process.cwd(), '..', '..')];

  let chosen = process.cwd();
  for (const c of candidates) {
    if (await hasDocsDir(c)) {
      chosen = c;
      break;
    }
  }
  // Canonicalise so containment checks in readDocFile compare real paths.
  cachedRoot = await fs.realpath(chosen).catch(() => chosen);
  return cachedRoot;
}

export const platformDocsRoutes = new Hono<{ Variables: AuthVars }>();
platformDocsRoutes.use('*', requireAuth());

platformDocsRoutes.get('/', async (c) => {
  const root = await resolveDocsRoot();
  return c.json(await buildDocsTree(root));
});

platformDocsRoutes.get('/content', async (c) => {
  const root = await resolveDocsRoot();
  return c.json(await readDocFile(root, c.req.query('path')));
});
