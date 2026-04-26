/**
 * v1 EPIC 1 PR-C (ISS-295) — Widget JS bundle delivery.
 *
 * `GET /widget/:slug/forge-widget.js` serves the static IIFE bundle that
 * `forge/web` produces via `npm run build:widget`. The bundle is project-
 * agnostic; we still scope by slug so that a 404 surfaces clearly when an
 * embedder pastes a stale snippet, and so per-project request logs make
 * sense. The bundle is read once per process lifetime, hashed for ETag, and
 * served with `public, max-age=300`. Conditional GETs (`If-None-Match`)
 * short-circuit to 304.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';

type CachedBundle = { body: Buffer; etag: string; contentType: string };

let cached: CachedBundle | null = null;

async function loadBundle(): Promise<CachedBundle | null> {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  // src/widget → ../../public when running from src; build outputs to
  // dist/widget so dist/widget → ../../public also resolves correctly.
  const bundlePath = resolve(here, '..', '..', 'public', 'forge-widget.js');
  try {
    await stat(bundlePath);
  } catch {
    return null;
  }
  const body = await readFile(bundlePath);
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
  cached = { body, etag, contentType: 'application/javascript; charset=utf-8' };
  return cached;
}

/** Force a bundle reload — used by tests to swap fixture contents. */
export function invalidateBundleCache(): void {
  cached = null;
}

export const widgetBundleRoutes = new Hono();

widgetBundleRoutes.get('/:slug/forge-widget.js', async (c) => {
  const slug = c.req.param('slug');
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);

  if (!project) {
    return c.text('not found', 404);
  }

  const bundle = await loadBundle();
  if (!bundle) {
    return c.text('widget bundle missing — run forge/web build:widget', 500);
  }

  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch === bundle.etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: bundle.etag,
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  return new Response(
    new Uint8Array(bundle.body.buffer, bundle.body.byteOffset, bundle.body.byteLength),
    {
      status: 200,
      headers: {
        'Content-Type': bundle.contentType,
        ETag: bundle.etag,
        'Cache-Control': 'public, max-age=300',
      },
    },
  );
});
