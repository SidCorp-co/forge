/**
 * v1 EPIC 1 PR-C (ISS-295) — Widget JS bundle delivery.
 *
 * `GET /widget/:slug/forge-widget.js` serves the static IIFE bundle that
 * `packages/web` produces via `npm run build:widget`. The bundle is project-
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

type CachedBundle = { body: Buffer; etag: string; contentType: string; mtimeMs: number };

let cached: CachedBundle | null = null;
let bundlePathOverride: string | null = null;

function defaultBundlePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/widget → ../../public when running from src; build outputs to
  // dist/widget so dist/widget → ../../public also resolves correctly.
  return resolve(here, '..', '..', 'public', 'forge-widget.js');
}

/** Override the on-disk bundle path; used by tests so they don't clobber the
 *  real `packages/core/public/forge-widget.js` produced by `pnpm --filter web
 *  build:widget`. Pass `null` to restore the default. */
export function setBundlePathForTesting(p: string | null): void {
  bundlePathOverride = p;
  cached = null;
}

async function loadBundle(): Promise<CachedBundle | null> {
  const bundlePath = bundlePathOverride ?? defaultBundlePath();
  let mtimeMs: number;
  try {
    const st = await stat(bundlePath);
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const body = await readFile(bundlePath);
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
  cached = { body, etag, contentType: 'application/javascript; charset=utf-8', mtimeMs };
  return cached;
}

/** Force a bundle reload — used by tests to swap fixture contents and by an
 *  out-of-band signal (e.g. SIGUSR2) if a future deploy needs to rebuild
 *  in-place without restarting core. */
export function invalidateBundleCache(): void {
  cached = null;
}

const SLUG_RE = /^[a-z0-9-]{3,64}$/;

export const widgetBundleRoutes = new Hono();

// Mounted at `/api/widget` so the staging reverse proxy (which routes only
// `/api/*` to core) reaches the bundle. Browsers don't enforce CORS for
// `<script src>`, and the bundle is meant to be loaded cross-origin from any
// embed snippet — do not wrap this in `cors()`; doing so would tie embedders
// to the allow-list.
widgetBundleRoutes.get('/:slug/forge-widget.js', async (c) => {
  const slug = c.req.param('slug');
  if (!SLUG_RE.test(slug)) return c.text('not found', 404);

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
    return c.text('widget bundle missing — run packages/web build:widget', 500);
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

  // `Buffer` extends `Uint8Array`, but the `Response` constructor's typed
  // overloads narrow on the parent class; cast through Uint8Array to keep
  // tsc happy without copying bytes.
  return new Response(bundle.body as unknown as Uint8Array, {
    status: 200,
    headers: {
      'Content-Type': bundle.contentType,
      ETag: bundle.etag,
      'Cache-Control': 'public, max-age=300',
    },
  });
});
