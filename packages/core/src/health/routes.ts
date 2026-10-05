/**
 * The ops snapshot over REST, in the two shapes its callers actually use.
 *
 * `readOpsHealth` takes a list of project ids, and the two routes here differ
 * only in what they put in that list. Measured on forge-beta 2026-09-01 over
 * the tool this replaces: 53 of 55 calls named no project at all, so the
 * fan-out is the real caller and dropping it would have broken them silently.
 */

import { Hono } from 'hono';
import pkg from '../../package.json' with { type: 'json' };
import { sourceCommit } from '../lib/source-commit.js';
import { readLiveness } from './service.js';
export const publicHealthRoutes = new Hono();

publicHealthRoutes.get('/health', async (c) => {
  const live = await readLiveness();
  return c.json(
    {
      ok: live.ok,
      db: { ok: live.dbOk },
      queue: { ok: live.queueOk },
      ws: { ok: live.wsOk },
    },
    live.ok ? 200 : 503,
  );
});

// Mounted at `/` and at `/api` both. Only the second carries CORS — `app.use('/api/*',
// corsMiddleware)` covers that prefix and nothing else — and only the second is where the
// web app's client points, so the root copy alone left the page unable to read this.
publicHealthRoutes.get('/version', (c) =>
  c.json({
    version: pkg.version,
    sourceCommit,
    uptimeSeconds: Math.floor(process.uptime()),
  }),
);

export { projectHealthRoutes } from './project-health-routes.js';
