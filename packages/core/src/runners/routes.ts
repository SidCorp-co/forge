import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { db } from '../db/client.js';
import {
  agentSessions,
  type RunnerStatus,
  type RunnerType,
  runnerEvents,
  runners,
} from '../db/schema.js';
import { assertDeviceBindable } from '../devices/bind-authority.js';
import { resolveDeviceUnbound } from '../devices/unbound-notice.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { resolvedWindowDaysFor } from '../pipeline/retention/policy.js';
import { projectRoom } from '../ws/rooms.js';
import { roomManager } from '../ws/server.js';
import { runnerHealthWithBuild } from './build-comparison.js';
import { clearRunnerQuarantine } from './quarantine.js';
import { getRunnerAdapter, listRunnerTypes } from './registry.js';
import {
  activeQuery,
  activeRunnersSchema,
  activityQuery,
  checkRunnerHealth,
  clearRunnerQuarantineRoute,
  createBody,
  createRunner,
  deleteRunner,
  excludeRunner,
  healthSchema,
  idParam,
  includeRunner,
  listActiveRunners,
  listQuery,
  listRunners,
  listRunnerTypesRoute,
  okSchema,
  patchBody,
  patchRunner,
  publicRunner,
  quotaSchema,
  readRunner,
  readRunnerActivity,
  refreshRunnerQuota,
  rowToRunner,
  runnerActivitySchema,
  runnerListSchema,
  runnerOneSchema,
  runnerTypesSchema,
} from './routes-reference.js';
import { setRunnerStatus } from './runner-events.js';
import { defaultRunnerCapabilities } from './select.js';
import { insertRunner, RunnerAlreadyBoundError } from './service.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = () =>
  new HTTPException(404, { message: 'runner not found', cause: { code: 'NOT_FOUND' } });

const forbidden = (msg: string) =>
  new HTTPException(403, { message: msg, cause: { code: 'FORBIDDEN' } });

export const runnerRoutes = new Hono<{ Variables: AuthVars }>();

runnerRoutes.use('*', requireAuth(), assertEmailVerified());

runnerRoutes.get('/types', listRunnerTypesRoute, async (c) => {
  const types = listRunnerTypes().map((a) => ({
    type: a.type,
    configSchema: 'configSchema' in a && a.configSchema ? '<zod>' : null,
  }));
  return c.json(answer(runnerTypesSchema, { types }));
});

runnerRoutes.get(
  '/',
  listRunners,
  zValidator('query', listQuery, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const q = c.req.valid('query');
    const filters = [];
    if (q.projectId) {
      const access = await loadProjectAccess(q.projectId, userId);
      if (!access.role) throw forbidden('not a project member');
      filters.push(eq(runners.projectId, q.projectId));
    } else {
      return c.json(answer(runnerListSchema, { runners: [] }));
    }
    if (q.type) filters.push(eq(runners.type, q.type as RunnerType));
    if (q.status) filters.push(eq(runners.status, q.status as RunnerStatus));
    const rows = await db
      .select()
      .from(runners)
      .where(and(...filters));
    return c.json(
      answer(runnerListSchema, { runners: rows.map((r) => publicRunner(rowToRunner(r))) }),
    );
  },
);

runnerRoutes.get(
  '/active',
  listActiveRunners,
  zValidator('query', activeQuery, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { projectId } = c.req.valid('query');
    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const rows = await db.execute<{
      runner_id: string;
      runner_name: string;
      status: string;
      last_seen_at: string | null;
      job_id: string | null;
      job_type: string | null;
      dispatched_at: string | null;
      issue_id: string | null;
      iss_seq: number | null;
      issue_prefix: string | null;
      issue_title: string | null;
    }>(sql`
      SELECT
        r.id          AS runner_id,
        r.name        AS runner_name,
        r.status      AS status,
        r.last_seen_at AS last_seen_at,
        j.id          AS job_id,
        j.type        AS job_type,
        j.dispatched_at AS dispatched_at,
        i.id          AS issue_id,
        i.iss_seq     AS iss_seq,
        rp.issue_prefix AS issue_prefix,
        i.title       AS issue_title
      FROM runners r
      -- Orphan exclusion (ISS-258) lives in the JOIN, not a WHERE clause, so a
      -- runner whose only active job is parented by a terminal pipeline_run
      -- still appears — as IDLE — instead of dropping out of the result.
      LEFT JOIN jobs j
        ON j.runner_id = r.id
       AND j.status IN ('dispatched','running')
      LEFT JOIN pipeline_runs pr ON pr.id = j.pipeline_run_id
      LEFT JOIN issues i ON i.id = j.issue_id
      LEFT JOIN projects rp ON rp.id = i.project_id
      WHERE r.project_id = ${projectId}
        AND (j.id IS NULL OR pr.id IS NULL OR pr.status IN ('running','paused'))
      ORDER BY r.name ASC, j.dispatched_at ASC NULLS LAST
    `);

    const byRunner = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const existing = byRunner.get(row.runner_id);
      if (!existing || (!existing.job_id && row.job_id)) byRunner.set(row.runner_id, row);
    }

    const runnersOut = [...byRunner.values()].map((row) => ({
      runnerId: row.runner_id,
      name: row.runner_name,
      status: row.status,
      lastSeenAt: row.last_seen_at,
      current: row.job_id
        ? {
            jobId: row.job_id,
            stage: row.job_type,
            startedAt: row.dispatched_at,
            issueId: row.issue_id,
            issueRef: row.iss_seq != null ? formatIssueRef(row.issue_prefix, row.iss_seq) : null,
            issueTitle: row.issue_title,
          }
        : null,
    }));

    const busy = runnersOut.filter((r) => r.current).length;
    return c.json(
      answer(activeRunnersSchema, { runners: runnersOut, busy, total: runnersOut.length }),
    );
  },
);

runnerRoutes.get(
  '/:id',
  readRunner,
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const [row] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!row) throw notFound();
    const access = await loadProjectAccess(row.projectId, userId);
    if (!access.role) throw forbidden('not a project member');
    return c.json(answer(runnerOneSchema, { runner: publicRunner(rowToRunner(row)) }));
  },
);

// Per-runner activity feed — surfaces what a runner has been doing/erroring on,
// drawn entirely from data we already persist (no new capture): the change-gated
// `runner_events` status timeline + the recent agent_sessions that ran on this
// runner's device (with a best-effort error excerpt pulled from the transcript).
// Read-only; any project member. Powers the "Activity" disclosure on the project
// Runners screen so an operator can see e.g. a session's `[RESULT_ERROR] 401`
// without leaving the runner row.
runnerRoutes.get(
  '/:id/activity',
  readRunnerActivity,
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', activityQuery, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const { limit } = c.req.valid('query');
    const [row] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!row) throw notFound();
    const access = await loadProjectAccess(row.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const events = await db
      .select({
        id: runnerEvents.id,
        oldStatus: runnerEvents.oldStatus,
        newStatus: runnerEvents.newStatus,
        reason: runnerEvents.reason,
        ts: runnerEvents.ts,
      })
      .from(runnerEvents)
      .where(eq(runnerEvents.runnerId, id))
      .orderBy(desc(runnerEvents.ts))
      .limit(limit);

    // Recent sessions that ran on this runner's device (device-bound runners
    // only; remote/NULL-device runners have no device-scoped sessions). The
    // error excerpt is the last transcript line mentioning a tool/result error,
    // extracted in SQL so we never ship the full `messages` jsonb over the wire.
    const sessions = row.deviceId
      ? await db
          .select({
            id: agentSessions.id,
            title: agentSessions.title,
            status: agentSessions.status,
            failureReason: agentSessions.failureReason,
            updatedAt: agentSessions.updatedAt,
            errorExcerpt: sql<string | null>`(
              SELECT left(msg->>'content', 500)
              FROM jsonb_array_elements(${agentSessions.messages}) AS msg
              WHERE msg->>'content' ILIKE '%RESULT_ERROR%'
                 OR msg->>'content' ILIKE '%API Error%'
              ORDER BY (msg->>'timestamp')::numeric DESC NULLS LAST
              LIMIT 1
            )`,
          })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.deviceId, row.deviceId),
              eq(agentSessions.projectId, row.projectId),
            ),
          )
          .orderBy(desc(agentSessions.updatedAt))
          .limit(limit)
      : [];

    return c.json(
      answer(runnerActivitySchema, {
        events,
        sessions,
        retentionDays: resolvedWindowDaysFor('runner_events'),
      }),
    );
  },
);

runnerRoutes.post(
  '/',
  createRunner,
  zValidator('json', createBody, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const input = c.req.valid('json');
    const access = await loadProjectAccess(input.projectId, userId);
    assertProjectRole(access, 'admin', 'project admin only');

    const adapter = getRunnerAdapter(input.type);
    if (!adapter) throw badRequest({ type: 'no adapter registered for type' });

    const result = adapter.validateConfig(input.config);
    if (!result.ok) throw badRequest({ config: result.error });
    await assertDeviceBindable(input.deviceId, input.projectId);

    let row: Awaited<ReturnType<typeof insertRunner>>;
    try {
      row = await insertRunner({
        projectId: input.projectId,
        type: input.type,
        deviceId: input.deviceId,
        name: input.name,
        labels: input.labels ?? [],
        capabilities: defaultRunnerCapabilities(input.type, input.capabilities),
        config: result.config,
      });
    } catch (err) {
      if (err instanceof RunnerAlreadyBoundError) {
        throw new HTTPException(409, {
          message: err.message,
          cause: { code: 'RUNNER_ALREADY_BOUND', details: { runner: err.collided } },
        });
      }
      throw err;
    }

    await resolveDeviceUnbound(input.projectId, input.deviceId);
    roomManager.publish(projectRoom(input.projectId), {
      event: 'runner.created',
      data: { runnerId: row.id, type: row.type },
    });

    return c.json(answer(runnerOneSchema, { runner: publicRunner(rowToRunner(row)) }), 201);
  },
);

runnerRoutes.patch(
  '/:id',
  patchRunner,
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', patchBody, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    assertProjectRole(access, 'admin', 'project admin only');

    let nextConfig = existing.config as Record<string, unknown>;
    if (input.config) {
      const adapter = getRunnerAdapter(existing.type);
      if (!adapter) throw badRequest({ type: 'no adapter registered' });
      const merged = { ...nextConfig, ...input.config };
      const result = adapter.validateConfig(merged);
      if (!result.ok) throw badRequest({ config: result.error });
      nextConfig = result.config;
    }

    const update: Partial<typeof runners.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) update.name = input.name;
    if (input.labels !== undefined) update.labels = input.labels;
    if (input.capabilities !== undefined) update.capabilities = input.capabilities;
    if (input.config) update.config = nextConfig;

    const [updated] = await db.update(runners).set(update).where(eq(runners.id, id)).returning();
    if (!updated) throw notFound();

    // ISS-381 (2.3) — route the status mutation through the audited, change-gated
    // writer (appends a runner_events row only on an actual transition).
    let row = updated;
    if (input.status !== undefined) {
      await setRunnerStatus({ runnerId: id, newStatus: input.status, reason: 'operator_patch' });
      row = { ...updated, status: input.status };
    }

    roomManager.publish(projectRoom(row.projectId), {
      event: 'runner.updated',
      data: { runnerId: row.id, status: row.status },
    });

    return c.json(answer(runnerOneSchema, { runner: publicRunner(rowToRunner(row)) }));
  },
);

runnerRoutes.delete(
  '/:id',
  deleteRunner,
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    assertProjectRole(access, 'admin', 'project admin only');
    await db.delete(runners).where(eq(runners.id, id));
    roomManager.publish(projectRoom(existing.projectId), {
      event: 'runner.deleted',
      data: { runnerId: id },
    });
    return c.json(answer(okSchema, { ok: true }));
  },
);

runnerRoutes.post(
  '/:id/health-check',
  checkRunnerHealth,
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    if (!access.role) throw forbidden('not a project member');
    const adapter = getRunnerAdapter(existing.type);
    if (!adapter) throw badRequest({ type: 'no adapter registered' });
    return c.json(
      answer(
        healthSchema,
        await runnerHealthWithBuild(adapter, rowToRunner(existing), existing.deviceId),
      ),
    );
  },
);

runnerRoutes.post(
  '/:id/refresh-quota',
  refreshRunnerQuota,
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    assertProjectRole(access, 'member');
    const adapter = getRunnerAdapter(existing.type);
    if (!adapter?.refreshQuota) {
      return c.json(answer(quotaSchema, { remaining: null, limit: null }));
    }
    const result = await adapter.refreshQuota({ runner: rowToRunner(existing) });
    if (Object.keys(result).length > 0) {
      const config = (existing.config ?? {}) as Record<string, unknown>;
      const next = {
        ...config,
        quota: {
          ...(config.quota as object | undefined),
          ...result,
          refreshedAt: new Date().toISOString(),
        },
      };
      await db
        .update(runners)
        .set({ config: next, updatedAt: new Date() })
        .where(eq(runners.id, id));
    }
    return c.json(answer(quotaSchema, result));
  },
);

runnerRoutes.post(
  '/:id/exclude',
  excludeRunner,
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    // Same gate as PATCH `status` — exclude/include are status mutations.
    assertProjectRole(access, 'admin', 'project admin only');
    await setRunnerStatus({ runnerId: id, newStatus: 'disabled', reason: 'operator_exclude' });
    return c.json(answer(okSchema, { ok: true }));
  },
);

runnerRoutes.post(
  '/:id/include',
  includeRunner,
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    assertProjectRole(access, 'admin', 'project admin only');
    await setRunnerStatus({ runnerId: id, newStatus: 'offline', reason: 'operator_include' });
    return c.json(answer(okSchema, { ok: true }));
  },
);

runnerRoutes.post(
  '/:id/clear-quarantine',
  clearRunnerQuarantineRoute,
  zValidator('param', idParam, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    const { id } = c.req.valid('param');
    const [existing] = await db.select().from(runners).where(eq(runners.id, id)).limit(1);
    if (!existing) throw notFound();
    const access = await loadProjectAccess(existing.projectId, userId);
    assertProjectRole(access, 'admin', 'project admin only');
    await clearRunnerQuarantine(id, existing.projectId);
    return c.json(answer(okSchema, { ok: true }));
  },
);
