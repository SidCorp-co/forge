/**
 * ISS-305 — Project docs tree. Serves the markdown documentation that lives in
 * the project's checked-out repo (`projects.repoPath`) so the web Docs page can
 * render a tree + content pane + search + TOC. This is distinct from
 * `/api/knowledge` (RAG embedding ingest) — that is not a browsable file tree.
 *
 *   GET /api/projects/:projectId/docs                 — markdown file tree
 *   GET /api/projects/:projectId/docs/content?path=…  — one file's raw markdown
 *
 * Sources: top-level `*.md` (README, CLAUDE, CHANGELOG, …) plus everything
 * under a `docs/` directory, recursively. Read-only. Path-traversal is blocked
 * by resolving the requested path and asserting it stays within the repo root
 * (incl. a realpath check to defeat symlink escapes); only `.md`/`.mdx` files
 * are readable.
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

export const docsRoutes = new Hono<{ Variables: AuthVars }>();
docsRoutes.use('*', requireAuth(), assertEmailVerified());

const MD_EXT = new Set(['.md', '.mdx']);
const MAX_DEPTH = 8;
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1_000_000; // 1 MB — docs are prose, not data dumps.
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'target', '.turbo']);

interface DocNode {
  /** Repo-relative POSIX path, e.g. `docs/guide/setup.md`. */
  path: string;
  name: string;
  type: 'file' | 'dir';
  children?: DocNode[];
}

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
  // Canonicalise so containment checks below compare real paths.
  try {
    return await fs.realpath(path.resolve(project.repoPath));
  } catch {
    throw new HTTPException(404, {
      message: 'project repoPath does not exist on this host',
      cause: { code: 'REPO_PATH_MISSING' },
    });
  }
}

/** Recursively collect markdown files under `dir`, returning a sorted tree. */
async function walk(root: string, dir: string, depth: number, counter: { n: number }): Promise<DocNode[]> {
  if (depth > MAX_DEPTH || counter.n >= MAX_FILES) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: DocNode[] = [];
  for (const entry of entries) {
    if (counter.n >= MAX_FILES) break;
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const children = await walk(root, abs, depth + 1, counter);
      if (children.length > 0) {
        nodes.push({ path: rel, name: entry.name, type: 'dir', children });
      }
    } else if (entry.isFile() && MD_EXT.has(path.extname(entry.name).toLowerCase())) {
      counter.n += 1;
      nodes.push({ path: rel, name: entry.name, type: 'file' });
    }
  }
  // Dirs first, then files, each alphabetical.
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

docsRoutes.get('/:projectId/docs', async (c) => {
  const projectId = c.req.param('projectId');
  await assertProjectAccess(projectId, c.get('userId'), 'viewer');
  const root = await resolveRepoRoot(projectId);

  const counter = { n: 0 };
  const tree: DocNode[] = [];

  // Top-level markdown files (README.md, CLAUDE.md, CHANGELOG.md, …).
  let topEntries: import('node:fs').Dirent[] = [];
  try {
    topEntries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    topEntries = [];
  }
  for (const entry of topEntries) {
    if (counter.n >= MAX_FILES) break;
    if (
      entry.isFile() &&
      !entry.name.startsWith('.') &&
      MD_EXT.has(path.extname(entry.name).toLowerCase())
    ) {
      counter.n += 1;
      tree.push({ path: entry.name, name: entry.name, type: 'file' });
    }
  }

  // The `docs/` directory tree, if present.
  const docsDir = path.join(root, 'docs');
  try {
    const stat = await fs.stat(docsDir);
    if (stat.isDirectory()) {
      const children = await walk(root, docsDir, 1, counter);
      if (children.length > 0) {
        tree.push({ path: 'docs', name: 'docs', type: 'dir', children });
      }
    }
  } catch {
    // no docs/ dir — top-level files only.
  }

  tree.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return c.json({ items: tree, truncated: counter.n >= MAX_FILES });
});

docsRoutes.get('/:projectId/docs/content', async (c) => {
  const projectId = c.req.param('projectId');
  await assertProjectAccess(projectId, c.get('userId'), 'viewer');
  const root = await resolveRepoRoot(projectId);

  const rel = c.req.query('path');
  if (!rel || typeof rel !== 'string') {
    throw new HTTPException(400, {
      message: 'path query param is required',
      cause: { code: 'BAD_REQUEST' },
    });
  }
  if (!MD_EXT.has(path.extname(rel).toLowerCase())) {
    throw new HTTPException(400, {
      message: 'only .md/.mdx files are readable',
      cause: { code: 'BAD_REQUEST' },
    });
  }

  // Resolve and assert containment within the repo root (block ../ traversal).
  const abs = path.resolve(root, rel);
  const withinSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(withinSep)) {
    throw new HTTPException(400, {
      message: 'path escapes the project repo',
      cause: { code: 'PATH_TRAVERSAL' },
    });
  }

  // Realpath check defeats symlink escapes (a symlink inside the repo pointing
  // out of it). Missing file → 404.
  let realAbs: string;
  try {
    realAbs = await fs.realpath(abs);
  } catch {
    throw notFound('doc');
  }
  if (realAbs !== root && !realAbs.startsWith(withinSep)) {
    throw new HTTPException(400, {
      message: 'path escapes the project repo',
      cause: { code: 'PATH_TRAVERSAL' },
    });
  }

  const stat = await fs.stat(realAbs).catch(() => null);
  if (!stat || !stat.isFile()) throw notFound('doc');
  if (stat.size > MAX_FILE_BYTES) {
    throw new HTTPException(413, {
      message: 'doc too large to render',
      cause: { code: 'TOO_LARGE' },
    });
  }

  const content = await fs.readFile(realAbs, 'utf8');
  return c.json({ path: rel.split(path.sep).join('/'), content });
});
