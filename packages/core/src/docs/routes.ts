/**
 * ISS-305 — Project docs tree. Serves the markdown documentation that lives in
 * the project's checked-out repo (`projects.repoPath`) so the web Docs page can
 * render a tree + content pane + search + TOC. This is distinct from
 * `/api/knowledge` (RAG embedding ingest) — that is not a browsable file tree.
 *
 *   GET /api/projects/:projectId/docs                 — markdown file tree
 *   GET /api/projects/:projectId/docs/content?path=…  — one file's raw markdown
 *
 * For FORGE's OWN platform docs (the global `/docs` nav, independent of any
 * project), see `platform-routes.ts` — that reads the docs bundled with the
 * deployment, not a project repo. Tree-building + path containment live in the
 * shared `read.ts` so both surfaces are gated identically.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { assertProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { buildDocsTree, readDocFile } from './read.js';

export const docsRoutes = new Hono<{ Variables: AuthVars }>();
docsRoutes.use('*', requireAuth(), assertEmailVerified());

const notFound = (entity: string) =>
  new HTTPException(404, { message: `${entity} not found`, cause: { code: 'NOT_FOUND' } });

async function resolveRepoRoot(projectId: string): Promise<string> {
  const [project] = await db
    .select({ repoPath: projects.repoPath })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound('project');
  if (!project.repoPath) {
    throw new HTTPException(404, {
      message: 'project has no repoPath configured — docs unavailable',
      cause: { code: 'NO_REPO_PATH' },
    });
  }
  // Canonicalise so containment checks compare real paths.
  try {
    return await fs.realpath(path.resolve(project.repoPath));
  } catch {
    throw new HTTPException(404, {
      message: 'project repoPath does not exist on this host',
      cause: { code: 'REPO_PATH_MISSING' },
    });
  }
}

docsRoutes.get('/:projectId/docs', async (c) => {
  const projectId = c.req.param('projectId');
  await assertProjectAccess(projectId, c.get('userId'), 'viewer');
  const root = await resolveRepoRoot(projectId);
  return c.json(await buildDocsTree(root));
});

docsRoutes.get('/:projectId/docs/content', async (c) => {
  const projectId = c.req.param('projectId');
  await assertProjectAccess(projectId, c.get('userId'), 'viewer');
  const root = await resolveRepoRoot(projectId);
  return c.json(await readDocFile(root, c.req.query('path')));
});
