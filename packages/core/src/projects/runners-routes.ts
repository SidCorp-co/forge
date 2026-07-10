import { zValidator } from '@hono/zod-validator';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { devices, runners } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { insertRunnerEvent } from '../runners/runner-events.js';
import { defaultRunnerCapabilities } from '../runners/select.js';

// ISS-172 Slice A — runner-shaped binding endpoints. `POST /:id/runners`
// upserts a (project, device, 'claude-code') runner row; `DELETE
// /:id/runners/:runnerId` removes one binding (other projects' runners on
// the same device are untouched).

const idParamSchema = z.object({
  id: z.uuid(),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, {
    message: 'Invalid input',
    cause: { code: 'BAD_REQUEST', details },
  });

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

// NOTE: mounted under `projectRoutes` (see ./routes.ts), which applies
// requireAuth() + assertEmailVerified() to every request — no own middleware
// here, or auth (and its email-verified DB lookup) would run twice.
export const projectRunnerRoutes = new Hono<{ Variables: AuthVars }>();

// Project-centric runner list — the device pools serving THIS project, with
// device identity + live provision status. Powers the project Runners screen
// (the inverse of the device-centric GET /api/devices/:id/runners). Any member.
projectRunnerRoutes.get(
  '/:id/runners',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(id, userId);
    assertProjectRole(access, 'viewer', 'project member required');

    const rows = await db
      .select({
        runnerId: runners.id,
        deviceId: runners.deviceId,
        deviceName: devices.name,
        platform: devices.platform,
        deviceStatus: devices.status,
        // Operator "turn off" timestamp. A disabled device's runner can still
        // heartbeat (status stays 'online'), so the UI needs this to explain
        // why an "online"-looking runner receives no jobs (mirrors the
        // dispatch gate that excludes disabled devices).
        deviceDisabledAt: devices.disabledAt,
        runnerStatus: runners.status,
        lastError: runners.lastError,
        limitReason: runners.limitReason,
        rateLimitedUntil: runners.rateLimitedUntil,
        limitDetail: runners.limitDetail,
        repoPath: runners.repoPath,
        branch: runners.branch,
        lastSeenAt: runners.lastSeenAt,
        provisionStatus: runners.provisionStatus,
        provisionDetail: runners.provisionDetail,
        provisionedAt: runners.provisionedAt,
      })
      .from(runners)
      .leftJoin(devices, eq(devices.id, runners.deviceId))
      .where(and(eq(runners.projectId, id), eq(runners.type, 'claude-code')))
      .orderBy(runners.createdAt);

    return c.json(rows);
  },
);

projectRunnerRoutes.post(
  '/:id/runners',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', createRunnerBodySchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { deviceId, capabilities, repoPath, branch } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    assertProjectRole(access, 'admin', 'project admin required');

    const [device] = await db
      .select({
        id: devices.id,
        name: devices.name,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);
    if (!device) {
      throw new HTTPException(404, {
        message: 'device not found',
        cause: { code: 'DEVICE_NOT_FOUND' },
      });
    }

    const status: 'online' | 'offline' =
      device.status === 'online' && device.lastSeenAt ? 'online' : 'offline';

    const now = new Date();
    const [runner] = await db
      .insert(runners)
      .values({
        projectId: id,
        type: 'claude-code',
        host: 'device',
        deviceId,
        name: device.name,
        capabilities: defaultRunnerCapabilities('claude-code', capabilities),
        ...(repoPath !== undefined ? { repoPath } : {}),
        ...(branch !== undefined ? { branch } : {}),
        status,
        // Queue workspace provisioning — the device picks this up on its next
        // GET /api/devices/me/provisions (online or whenever it reconnects).
        provisionStatus: 'queued',
        provisionRequestedAt: now,
      })
      .onConflictDoUpdate({
        target: [runners.projectId, runners.deviceId, runners.type],
        targetWhere: sql`device_id IS NOT NULL`,
        set: {
          status,
          updatedAt: now,
          ...(capabilities ? { capabilities } : {}),
          ...(repoPath !== undefined ? { repoPath } : {}),
          ...(branch !== undefined ? { branch } : {}),
          // Re-bind re-queues provisioning (path/url may have changed).
          provisionStatus: 'queued',
          provisionDetail: null,
          provisionRequestedAt: now,
        },
      })
      .returning({
        id: runners.id,
        projectId: runners.projectId,
        deviceId: runners.deviceId,
        repoPath: runners.repoPath,
        branch: runners.branch,
        status: runners.status,
      });

    if (!runner) {
      throw new HTTPException(500, {
        message: 'runner upsert returned no row',
        cause: { code: 'RUNNER_UPSERT_FAILED' },
      });
    }

    // ISS-381 (2.3) — audit the bind as the runner's initial status event
    // (old_status null). Bind is an infrequent operator action, so an event per
    // bind is informative, not noisy (unlike the per-tick heartbeat site).
    await insertRunnerEvent(db, {
      runnerId: runner.id,
      projectId: runner.projectId,
      oldStatus: null,
      newStatus: runner.status,
      reason: 'bind',
    });

    // Wake the device room so an online device pulls its queued provision now;
    // an offline device picks it up from the `queued` row on reconnect.
    if (runner.deviceId) {
      await hooks.emit('runnerProvisionRequested', {
        projectId: runner.projectId,
        deviceId: runner.deviceId,
        runnerId: runner.id,
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
  })
  .strict();

projectRunnerRoutes.patch(
  '/:id/runners/:runnerId',
  zValidator('param', runnerParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', patchRunnerBodySchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id, runnerId } = c.req.valid('param');
    const { repoPath, branch, capabilities } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    assertProjectRole(access, 'admin', 'project admin required');

    const [runner] = await db
      .update(runners)
      .set({
        updatedAt: new Date(),
        ...(repoPath !== undefined ? { repoPath } : {}),
        ...(branch !== undefined ? { branch } : {}),
        ...(capabilities ? { capabilities } : {}),
      })
      .where(and(eq(runners.id, runnerId), eq(runners.projectId, id)))
      .returning({
        id: runners.id,
        projectId: runners.projectId,
        deviceId: runners.deviceId,
        repoPath: runners.repoPath,
        branch: runners.branch,
        status: runners.status,
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

projectRunnerRoutes.delete(
  '/:id/runners/:runnerId',
  zValidator('param', runnerParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id, runnerId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    assertProjectRole(access, 'admin', 'project admin required');

    // Idempotent: 204 whether the runner existed or not, mirroring the old
    // PUT/DELETE /:id/devices/:deviceId contract.
    await db.delete(runners).where(and(eq(runners.id, runnerId), eq(runners.projectId, id)));
    return c.body(null, 204);
  },
);
