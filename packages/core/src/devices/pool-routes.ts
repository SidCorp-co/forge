/**
 * The device-facing half of master orchestration: read the pool, take work,
 * give it back, and read load.
 *
 * Every route here is the device's own principal — the master reaches core
 * only through its daemon, so there is one holder of the device token.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { type DeviceVars, requireDevice } from '../middleware/require-device.js';
import { claimJobForMaster, releaseAllHeldBySession, releaseJobFromMaster } from './claim.js';
import { readDeviceLoad, readFleetLoad, readProjectLoad } from './load.js';
import { readPool } from './pool.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

// cm:guard `requireDevice`, never `requireAnyAuth`. Only the latter sets `userId = device.ownerId`, which would hand a master session its owner's whole account authority; these routes must stay scoped to the device's own bindings so `loadProjectAccess` fails closed.
export const devicePoolRoutes = new Hono<{ Variables: DeviceVars }>();

const poolQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  projectId: z.string().uuid().optional(),
});

devicePoolRoutes.get(
  '/me/pool',
  requireDevice(),
  zValidator('query', poolQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { limit, projectId } = c.req.valid('query');
    const deviceId = c.get('device').id;
    const items = await readPool({ deviceId, projectId, limit });
    return c.json({ items, count: items.length });
  },
);

const claimBodySchema = z.object({
  jobId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

devicePoolRoutes.post(
  '/me/pool/claim',
  requireDevice(),
  zValidator('json', claimBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { jobId, sessionId } = c.req.valid('json');
    const result = await claimJobForMaster({ jobId, deviceId: c.get('device').id, sessionId });
    // cm:guard a refused claim answers 200 with `ok:false`, NOT 4xx. A full box and a lost race are ordinary outcomes a master handles by choosing differently; making them errors invites a retry loop against a condition retrying cannot change.
    return c.json(result);
  },
);

const releaseBodySchema = z.object({
  jobId: z.string().uuid().optional(),
  sessionId: z.string().uuid(),
});

devicePoolRoutes.post(
  '/me/pool/release',
  requireDevice(),
  zValidator('json', releaseBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { jobId, sessionId } = c.req.valid('json');
    if (jobId) {
      const released = await releaseJobFromMaster({ jobId, sessionId });
      return c.json({ released: released ? 1 : 0 });
    }
    const released = await releaseAllHeldBySession(sessionId);
    return c.json({ released });
  },
);

const loadQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
});

devicePoolRoutes.get(
  '/me/load',
  requireDevice(),
  zValidator('query', loadQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const deviceId = c.get('device').id;
    const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);

    const device = await readDeviceLoad(deviceId);
    const project = projectId ? await readProjectLoad(projectId) : null;
    const fleet = projectId ? await readFleetLoad(projectId, livenessSeconds) : [];

    // cm:guard report raw counts and NEVER a recommendation field like `canTakeMore`. That number would be core deciding batch size again — the ceiling this design removed, wearing a helpful name — and a master reading it would stop weighing the facts that made it.
    return c.json({ device, project, fleet });
  },
);
