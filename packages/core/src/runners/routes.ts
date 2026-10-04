import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type RunnerStatus, type RunnerType, runnerStatuses, runnerTypes } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { projectRoom, roomManager } from '../lib/rooms.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { resolvedWindowDaysFor } from '../pipeline/index.js';
import {
  activeRunnersOf,
  listProjectRunners,
  type RunnerRow,
  runnerActivity,
  runnerRow,
} from './read.js';
import { getRunnerAdapter } from './registry.js';
import { setRunnerStatus } from './runner-events.js';
import { defaultRunnerCapabilities } from './select.js';
import { deleteRunner, insertRunner, updateRunner } from './service.js';
import type { Runner } from './types.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = () =>
  new HTTPException(404, { message: 'runner not found', cause: { code: 'NOT_FOUND' } });

function rowToRunner(r: RunnerRow): Runner {
  return {
    id: r.id,
    projectId: r.projectId,
    type: r.type,
    deviceId: r.deviceId,
    name: r.name,
    labels: Array.isArray(r.labels) ? (r.labels as string[]) : [],
    capabilities: (r.capabilities ?? {}) as Record<string, unknown>,
    config: (r.config ?? {}) as Record<string, unknown>,
    status: r.status,
    lastSeenAt: r.lastSeenAt,
    lastError: r.lastError,
    limitReason: r.limitReason,
    rateLimitedUntil: r.rateLimitedUntil,
    limitDetail: r.limitDetail,
    quarantinedUntil: r.quarantinedUntil,
    quarantineReason: r.quarantineReason,
  };
}

function publicRunner(r: Runner): Omit<Runner, 'config'> & { config: Record<string, unknown> } {
  const config = { ...r.config };
  if ('apiKey' in config) config.apiKey = '***';
  if ('callbackSecret' in config) config.callbackSecret = '***';
  return { ...r, config };
}

const createBody = z
  .object({
    projectId: z.uuid(),
    type: z.enum(runnerTypes),
    name: z.string().min(1).max(120),
    deviceId: z.uuid(),
    labels: z.array(z.string()).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const patchBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    labels: z.array(z.string()).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    status: z.enum(['draining', 'disabled', 'offline', 'online']).optional(),
  })
  .strict();

const idParam = z.object({ id: z.uuid() });

const listQuery = z.object({
  projectId: z.uuid().optional(),
  type: z.enum(runnerTypes).optional(),
  status: z.enum(runnerStatuses).optional(),
});

export const runnerRoutes = new Hono<{ Variables: AuthVars }>();

runnerRoutes.use('*', requireAuth(), assertEmailVerified());

runnerRoutes.get(
  '/',
  zValidator('query', listQuery, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const userId = c.get('userId');
    const q = c.req.valid('query');
    if (!q.projectId) return c.json({ runners: [] });
    const access = await loadProjectAccess(q.projectId, userId);
    requireHeld(access, 'project.read');
    const rows = await listProjectRunners(q.projectId, {
      type: q.type as RunnerType | undefined,
      status: q.status as RunnerStatus | undefined,
    });
    return c.json({ runners: rows.map((r) => publicRunner(rowToRunner(r))) });
  },
);

const activeQuery = z.object({ projectId: z.uuid() });

runnerRoutes.get(
  '/active',
  zValidator('query', activeQuery, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const userId = c.get('userId');
    const { projectId } = c.req.valid('query');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    return c.json(await activeRunnersOf(projectId));
  },
);

runnerRoutes.get(
  '/:id',
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const row = await runnerRow(id);
    if (!row) throw notFound();
    const access = await loadProjectAccess(row.projectId, userId);
    requireHeld(access, 'project.read');
    return c.json({ runner: publicRunner(rowToRunner(row)) });
  },
);

// Per-runner activity feed — surfaces what a runner has been doing/erroring on,
// drawn entirely from data we already persist (no new capture): the change-gated
// `runner_events` status timeline + the recent agent_sessions that ran on this
// runner's device (with a best-effort error excerpt pulled from the transcript).
// Read-only; any project member. Powers the "Activity" disclosure on the project
// Runners screen so an operator can see e.g. a session's `[RESULT_ERROR] 401`
// without leaving the runner row.
const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(15),
});

runnerRoutes.get(
  '/:id/activity',
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', activityQuery, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    const row = await runnerRow(id);
    if (!row) throw notFound();
    const access = await loadProjectAccess(row.projectId, userId);
    requireHeld(access, 'project.read');

    const { events, sessions } = await runnerActivity(row, limit);

    return c.json({
      events,
      sessions,
      retentionDays: resolvedWindowDaysFor('runner_events'),
    });
  },
);

runnerRoutes.post(
  '/',
  zValidator('json', createBody, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const userId = c.get('userId');
    const input = c.req.valid('json');
    const access = await loadProjectAccess(input.projectId, userId);
    requireHeld(access, 'project.admin');

    const adapter = getRunnerAdapter(input.type);
    if (!adapter) throw badRequest({ type: 'no adapter registered for type' });

    const result = adapter.validateConfig(input.config);
    if (!result.ok) throw badRequest({ config: result.error });

    const row = await insertRunner({
      projectId: input.projectId,
      type: input.type,
      deviceId: input.deviceId,
      name: input.name,
      labels: input.labels ?? [],
      capabilities: defaultRunnerCapabilities(input.type, input.capabilities),
      config: result.config,
    });

    roomManager.publish(projectRoom(input.projectId), {
      event: 'runner.created',
      data: { runnerId: row.id, type: row.type },
    });

    return c.json({ runner: publicRunner(rowToRunner(row)) }, 201);
  },
);

runnerRoutes.patch(
  '/:id',
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', patchBody, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const existing = await runnerRow(id);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    requireHeld(access, 'project.admin');

    let nextConfig = existing.config as Record<string, unknown>;
    if (input.config) {
      const adapter = getRunnerAdapter(existing.type);
      if (!adapter) throw badRequest({ type: 'no adapter registered' });
      const merged = { ...nextConfig, ...input.config };
      const result = adapter.validateConfig(merged);
      if (!result.ok) throw badRequest({ config: result.error });
      nextConfig = result.config;
    }

    const update: Parameters<typeof updateRunner>[1] = {};
    if (input.name !== undefined) update.name = input.name;
    if (input.labels !== undefined) update.labels = input.labels;
    if (input.capabilities !== undefined) update.capabilities = input.capabilities;
    if (input.config) update.config = nextConfig;

    const updated = await updateRunner(id, update);
    if (!updated) throw notFound();

    // ISS-381 (2.3) — route the status mutation through the audited, change-gated
    // writer (appends a runner_events row only on an actual transition).
    let row = updated;
    if (input.status !== undefined) {
      await setRunnerStatus({
        runnerId: id,
        newStatus: input.status,
        reason: 'operator_patch',
        actor: restActor(c),
      });
      row = { ...updated, status: input.status };
    }

    roomManager.publish(projectRoom(row.projectId), {
      event: 'runner.updated',
      data: { runnerId: row.id, status: row.status },
    });

    return c.json({ runner: publicRunner(rowToRunner(row)) });
  },
);

runnerRoutes.delete(
  '/:id',
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const existing = await runnerRow(id);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    requireHeld(access, 'project.admin');
    await deleteRunner(id);
    roomManager.publish(projectRoom(existing.projectId), {
      event: 'runner.deleted',
      data: { runnerId: id },
    });
    return c.json({ ok: true });
  },
);

export { projectRunnerRoutes } from './project-routes.js';
