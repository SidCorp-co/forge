/**
 * The ops snapshot over REST, in the two shapes its callers actually use.
 *
 * `readOpsHealth` takes a list of project ids, and the two routes here differ
 * only in what they put in that list. Measured on forge-beta 2026-09-01 over
 * the tool this replaces: 53 of 55 calls named no project at all, so the
 * fan-out is the real caller and dropping it would have broken them silently.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };
import { sourceCommit } from '../lib/source-commit.js';
import { zValidator } from '../middleware/zod-validator.js';
import { bossErrorTally } from '../queue/boss-errors.js';
import { readLiveness } from './service.js';
export const publicHealthRoutes = new Hono();

// a deploy probe reads these with a cache-buster appended (integrations/deploy/runtime-probe.ts,
// integrations/deploy/coolify/health-probe.ts), so it is the one key they take
const probeQuery = zValidator('query', z.object({ _forge_cb: z.string().max(64).optional() }));

publicHealthRoutes.get('/health', probeQuery, async (c) => {
  const live = await readLiveness();
  return c.json(
    {
      ok: live.ok,
      db: { ok: live.dbOk },
      // a count, never a message: this route is public, and the line itself is in the log
      queue: { ok: live.queueOk, errorsSinceBoot: bossErrorTally().count },
      ws: { ok: live.wsOk },
    },
    live.ok ? 200 : 503,
  );
});

// Mounted at `/` and at `/api` both. Only the second carries CORS — `app.use('/api/*',
// corsMiddleware)` covers that prefix and nothing else — and only the second is where the
// web app's client points, so the root copy alone left the page unable to read this.
publicHealthRoutes.get('/version', probeQuery, (c) =>
  c.json({
    version: pkg.version,
    sourceCommit,
    uptimeSeconds: Math.floor(process.uptime()),
  }),
);

export { projectHealthRoutes } from './project-health-routes.js';
