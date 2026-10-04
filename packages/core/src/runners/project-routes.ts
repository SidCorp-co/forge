import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { readRunnerPoolRead } from '../devices/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, restActor } from '../middleware/auth.js';
import { badRequest, idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { clearRunnerFaultFlags } from './clear-fault-flags.js';
import {
  bindDeviceRunner,
  deviceForBind,
  listProjectRunnerPools,
  projectHasRunner,
} from './project-binding.js';
import { deleteProjectRunner, patchProjectRunner } from './writes.js';

// ISS-172 Slice A — runner-shaped binding endpoints. `POST /:id/runners`
// upserts a (project, device, 'claude-code') runner row; `DELETE
// /:id/runners/:runnerId` removes one binding (other projects' runners on
// the same device are untouched).

const createRunnerBodySchema = z
  .object({
    deviceId: z.uuid(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    // ISS-271 — per (device × project) repo checkout. Optional at bind time:
    // a web bind may leave them null until the operator sets the path later.
    repoPath: z.string().trim().max(500).nullable().optional(),
    branch: z.string().trim().max(100).nullable().optional(),
  })
  .strict();

// NOTE: mounted by the route registry right after `projectRoutes`, whose
// requireAuth() + assertEmailVerified() gate every request — no own middleware
// here, or auth (and its email-verified DB lookup) would run twice.
export const projectRunnerRoutes = new Hono<{ Variables: AuthVars }>();

// Project-centric runner list — the device pools serving THIS project, with
// device identity + live provision status. Powers the project Runners screen
// (the inverse of the device-centric GET /api/devices/:id/runners). Any member.
projectRunnerRoutes.get(
  '/:id/runners',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(id, userId);
    requireHeld(access, 'project.read');

    const rows = await listProjectRunnerPools(id);

    return c.json(rows.map((r) => ({ ...r, poolRead: readRunnerPoolRead(r.poolRead) })));
  },
);

projectRunnerRoutes.post(
  '/:id/runners',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator('json', createRunnerBodySchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { deviceId, capabilities, repoPath, branch } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    requireHeld(access, 'project.admin');

    const device = await deviceForBind(deviceId);
    if (!device) {
      throw new HTTPException(404, {
        message: 'device not found',
        cause: { code: 'DEVICE_NOT_FOUND' },
      });
    }

    const runner = await bindDeviceRunner({
      projectId: id,
      device,
      capabilities,
      checkout: { repoPath, branch },
      actor: restActor(c),
    });

    if (!runner) {
      throw new HTTPException(500, {
        message: 'runner upsert returned no row',
        cause: { code: 'RUNNER_UPSERT_FAILED' },
      });
    }


    return c.json(runner, 201);
  },
);

const runnerParamSchema = z.object({ id: z.uuid(), runnerId: z.uuid() });

// ISS-271 — update the per-device repo checkout (and capabilities) on a
// runner row. Web and the CLI `forge-runner bind` both write here, so the
// server stays the single source of truth for the runner working dir.
const patchRunnerBodySchema = z
  .object({
    repoPath: z.string().trim().max(500).nullable().optional(),
    branch: z.string().trim().max(100).nullable().optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    labels: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  })
  .strict();

projectRunnerRoutes.patch(
  '/:id/runners/:runnerId',
  zValidator('param', runnerParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  zValidator('json', patchRunnerBodySchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { id, runnerId } = c.req.valid('param');
    const { repoPath, branch, capabilities, labels } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    requireHeld(access, 'project.admin');

    const runner = await patchProjectRunner(id, runnerId, {
      repoPath,
      branch,
      capabilities,
      labels,
    });

    if (!runner) {
      throw new HTTPException(404, {
        message: 'runner not found',
        cause: { code: 'RUNNER_NOT_FOUND' },
      });
    }

    return c.json(runner);
  },
);

projectRunnerRoutes.post(
  '/:id/runners/:runnerId/clear-error',
  zValidator('param', runnerParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { id, runnerId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    requireHeld(access, 'project.admin');

    if (!(await projectHasRunner(id, runnerId))) {
      throw new HTTPException(404, {
        message: 'runner not found',
        cause: { code: 'RUNNER_NOT_FOUND' },
      });
    }

    const cleared = await clearRunnerFaultFlags(runnerId, id);
    return c.json({ runnerId, cleared });
  },
);

projectRunnerRoutes.delete(
  '/:id/runners/:runnerId',
  zValidator('param', runnerParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { id, runnerId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    requireHeld(access, 'project.admin');

    // Idempotent: 204 whether the runner existed or not, mirroring the old
    // PUT/DELETE /:id/devices/:deviceId contract.
    await deleteProjectRunner(id, runnerId);
    return c.body(null, 204);
  },
);
