/**
 * ISS-194 — Per-state model override flows from config to runner Inspector.
 *
 * Drives the full HTTP + DB round-trip for PR #127's per-state dispatch
 * override pipeline (config PATCH → orchestrator-stamped `stageStatus` →
 * `resolveStageOverrides` → `job.assigned` WS envelope → `GET /jobs/:id/prompt`
 * Inspector envelope) against real Postgres. No browser layer is exercised
 * because no rendered web UI yet sets `pipelineConfig.states.<status>.model`
 * and no Inspector UI yet renders `resolvedFlags` (PR-7b deferred). Once
 * those land, a follow-up issue should add a Playwright pass driving the
 * same fixtures end-to-end.
 *
 * Status-name correction: the issue body uses `states.code.model`, but the
 * schema keys `states` by status name. `code` jobs dispatch at status
 * `approved`, so the override path is `states.approved.model`.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestDatabase,
  createTestDevice,
  createTestProject,
  createTestUser,
  setProjectActiveDevice,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// Mock the WS server so we can assert on the `job.assigned` envelope without
// standing up a real socket layer. Both the legacy device dispatch path and
// `publishPipelineHealthChanged` route through this module.
vi.mock('../../src/ws/server.js', () => ({
  roomManager: {
    publish: vi.fn(() => 0),
  },
}));

describe('ISS-194 per-state override end-to-end', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
  let handleDispatch: typeof import('../../src/jobs/dispatcher.js').handleDispatch;
  let roomManager: { publish: ReturnType<typeof vi.fn> };
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.NODE_ENV ??= 'test';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    // Legacy device dispatch is the cheaper path and exercises the same
    // `buildOverridesPayload` call as the runner-framework path.
    process.env.FEATURE_RUNNER_FRAMEWORK = 'false';
    // `pipelineControl` defaults to true; assert explicitly so an env-level
    // override in CI cannot silently disable the PATCH route under test.
    process.env.FEATURE_PIPELINE_CONTROL = 'true';

    const wsMod = (await import('../../src/ws/server.js')) as unknown as {
      roomManager: { publish: ReturnType<typeof vi.fn> };
    };
    roomManager = wsMod.roomManager;

    const { jobRoutes } = await import('../../src/jobs/routes.js');
    const { projectRoutes } = await import('../../src/projects/routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    const dispatcherMod = await import('../../src/jobs/dispatcher.js');
    signUserToken = jwtMod.signUserToken;
    handleDispatch = dispatcherMod.handleDispatch;

    app = new Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/projects', projectRoutes);
    app.route('/api/jobs', jobRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    delete process.env.FEATURE_RUNNER_FRAMEWORK;
    delete process.env.FEATURE_PIPELINE_CONTROL;
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    roomManager.publish.mockClear();
  });

  async function seedOwnerProjectDevice(): Promise<{
    ownerId: string;
    projectId: string;
    deviceId: string;
    token: string;
  }> {
    const owner = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`,
    );
    const project = await createTestProject(harness.db, owner.id);
    const device = await createTestDevice(harness.db, owner.id, { status: 'online' });
    await harness.db.execute(sql`UPDATE devices SET last_seen_at = now() WHERE id = ${device.id}`);
    // Order matters: `setProjectActiveDevice` overwrites `agent_config`. Run
    // it BEFORE the pipeline-config PATCH so the PATCH (which merges via
    // `agent_config || patch::jsonb`) preserves `activeDeviceId`.
    await setProjectActiveDevice(harness.db, project.id, device.id);
    const token = await signUserToken(owner.id);
    return { ownerId: owner.id, projectId: project.id, deviceId: device.id, token };
  }

  async function patchPipelineConfig(
    projectId: string,
    token: string,
    body: unknown,
  ): Promise<Response> {
    return app.request(`/api/projects/${projectId}/pipeline-config`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async function insertIssue(projectId: string, ownerId: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, priority, created_by_id)
      VALUES (
        ${id}, ${projectId}, ${Math.floor(Math.random() * 1_000_000)},
        'Issue', 'open', 'medium', ${ownerId}
      )
    `);
    return id;
  }

  async function insertCodeJob(args: {
    projectId: string;
    issueId: string;
    ownerId: string;
  }): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${runId}, ${args.projectId}, ${args.issueId}, 'issue', 'running')
    `);
    const id = randomUUID();
    // `stageStatus: 'approved'` mirrors what the orchestrator stamps at
    // enqueue time. We bypass the orchestrator and write it directly so the
    // test stays focused on the resolve → forward → surface contract.
    const payload = JSON.stringify({ promptString: 'noop', stageStatus: 'approved' });
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload, created_by)
      VALUES (
        ${id}, ${args.projectId}, ${args.issueId}, ${runId}, 'code', 'queued',
        ${payload}::jsonb, ${args.ownerId}
      )
    `);
    return id;
  }

  function jobAssignedCall(): Record<string, unknown> {
    const calls = roomManager.publish.mock.calls.filter(
      (c) => (c[1] as { event?: string } | undefined)?.event === 'job.assigned',
    );
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('job.assigned publish call not captured');
    return (call[1] as { data: Record<string, unknown> }).data;
  }

  async function readProjectAgentConfig(projectId: string): Promise<Record<string, unknown>> {
    const rows = await harness.db.execute<{ agent_config: Record<string, unknown> | null }>(
      sql`SELECT agent_config FROM projects WHERE id = ${projectId}`,
    );
    return rows[0]?.agent_config ?? {};
  }

  it('forwards `model` + `permissionMode` from config to WS envelope and Inspector', async () => {
    const { ownerId, projectId, token } = await seedOwnerProjectDevice();

    // Use `mode: 'manual'` so the auto-mode check in pipeline-config-service
    // does not require a registered skill for the `approved` stage.
    const patchRes = await patchPipelineConfig(projectId, token, {
      states: {
        approved: {
          enabled: true,
          mode: 'manual',
          model: 'opus',
          permissionMode: 'acceptEdits',
        },
      },
    });
    expect(patchRes.status).toBe(200);

    const stored = await readProjectAgentConfig(projectId);
    expect(stored.pipelineConfig).toMatchObject({
      states: {
        approved: {
          enabled: true,
          mode: 'manual',
          model: 'opus',
          permissionMode: 'acceptEdits',
        },
      },
    });

    const issueId = await insertIssue(projectId, ownerId);
    const jobId = await insertCodeJob({ projectId, issueId, ownerId });

    const result = await handleDispatch({ jobId });
    expect(result).toBe('dispatched');

    const data = jobAssignedCall();
    expect(data.model).toBe('opus');
    expect(data.permissionMode).toBe('acceptEdits');
    expect(data.jobId).toBe(jobId);
    expect(data.projectId).toBe(projectId);
    expect(data.type).toBe('code');
    expect((data.payload as { stageStatus?: unknown }).stageStatus).toBe('approved');

    // Inspector envelope.
    const inspRes = await app.request(`/api/jobs/${jobId}/prompt`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(inspRes.status).toBe(200);
    const body = (await inspRes.json()) as {
      model: string | null;
      payloadExtras: Record<string, unknown>;
      resolvedFlags: {
        state: string | null;
        model: string | null;
        permissionMode: string | null;
      };
    };
    // `persistPromptSnapshot` writes `model_used = stageOverrides.model`, so
    // `resolvedFlags.model` (which prefers `job.modelUsed`) reflects the
    // operator override. `permissionMode` is forwarded only on the WS
    // envelope (the dispatcher does NOT update `jobs.payload`), so the
    // Inspector surfaces it as null — the WS-envelope assertion above is
    // where that override is proven for the Inspector contract.
    expect(body.resolvedFlags.state).toBe('approved');
    expect(body.resolvedFlags.model).toBe('opus');
    expect(body.model).toBe('opus');
    expect(Object.keys(body.payloadExtras)).not.toContain('model');
    expect(Object.keys(body.payloadExtras)).not.toContain('stageStatus');
  });

  it('reverting the override produces a new dispatch with default values', async () => {
    const { ownerId, projectId, token } = await seedOwnerProjectDevice();

    // 1. Apply override + dispatch one job to confirm the override path is
    //    actually live before the revert.
    const firstPatch = await patchPipelineConfig(projectId, token, {
      states: {
        approved: {
          enabled: true,
          mode: 'manual',
          model: 'opus',
          permissionMode: 'acceptEdits',
        },
      },
    });
    expect(firstPatch.status).toBe(200);

    const issueId1 = await insertIssue(projectId, ownerId);
    const jobId1 = await insertCodeJob({ projectId, issueId: issueId1, ownerId });
    expect(await handleDispatch({ jobId: jobId1 })).toBe('dispatched');
    expect(jobAssignedCall().model).toBe('opus');

    // 2. Revert the override. `updatePipelineConfig` shallow-merges at the
    //    `pipelineConfig` level — sending `states.approved` without `model`
    //    or `permissionMode` replaces the entire `states.approved` entry,
    //    dropping both keys.
    roomManager.publish.mockClear();
    const revertPatch = await patchPipelineConfig(projectId, token, {
      states: {
        approved: {
          enabled: true,
          mode: 'manual',
        },
      },
    });
    expect(revertPatch.status).toBe(200);

    const storedAfter = await readProjectAgentConfig(projectId);
    const stateAfter = (
      storedAfter.pipelineConfig as
        | {
            states?: { approved?: Record<string, unknown> };
          }
        | undefined
    )?.states?.approved as Record<string, unknown> | undefined;
    expect(stateAfter).toBeDefined();
    expect(Object.keys(stateAfter ?? {})).not.toContain('model');
    expect(Object.keys(stateAfter ?? {})).not.toContain('permissionMode');

    // 3. Dispatch a second code job with the override gone.
    const issueId2 = await insertIssue(projectId, ownerId);
    const jobId2 = await insertCodeJob({ projectId, issueId: issueId2, ownerId });
    expect(await handleDispatch({ jobId: jobId2 })).toBe('dispatched');

    const data2 = jobAssignedCall();
    // buildOverridesPayload only sets keys when the override is non-null —
    // with the override cleared, `model` + `permissionMode` are absent from
    // the WS envelope entirely.
    expect(Object.keys(data2)).not.toContain('model');
    expect(Object.keys(data2)).not.toContain('permissionMode');
    expect((data2.payload as { stageStatus?: unknown }).stageStatus).toBe('approved');

    const inspRes = await app.request(`/api/jobs/${jobId2}/prompt`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(inspRes.status).toBe(200);
    const body = (await inspRes.json()) as {
      model: string | null;
      resolvedFlags: {
        state: string | null;
        model: string | null;
        permissionMode: string | null;
      };
    };
    // With no override + no `job.modelTier`, `persistPromptSnapshot` writes
    // `model_used = 'default'`, which is what the Inspector surfaces.
    expect(body.resolvedFlags.state).toBe('approved');
    expect(body.resolvedFlags.model).toBe('default');
    expect(body.resolvedFlags.permissionMode).toBeNull();
    expect(body.model).toBe('default');
  });
});
