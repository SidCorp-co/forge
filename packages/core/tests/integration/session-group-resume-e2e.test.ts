/**
 * ISS-195 — Session-group resume forwards claudeSessionId across stages.
 *
 * Drives the full HTTP + DB round-trip for PR #127's session-group resume
 * contract (config PATCH → orchestrator-stamped `sessionGroup` →
 * `resolveStageOverrides` → `findPriorSessionInGroup` lookup → device pin →
 * `claudeSessionId` forwarded on the WS envelope / adapter payload) against
 * real Postgres. Mirrors the ISS-194 `per-state-override-e2e.test.ts` harness
 * — no browser layer, no Inspector UI for `claudeSessionId` yet (PR-7b
 * deferred). The Inspector envelope is asserted only for fields that already
 * persist into `jobs.payload` (sessionGroup, state).
 *
 * ISS-580 — also exercises `estimateGroupContextTokens` against real Postgres
 * to verify the text→uuid cast (`session_id::uuid`) compiles without the
 * "operator does not exist: text = uuid" runtime error that unit tests (which
 * mock `db.execute`) cannot catch.
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
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// Mock the WS server so we can assert on the `job.assigned` envelope without
// standing up a real socket layer. The claude-code adapter (runner path)
// publishes through this module.
vi.mock('../../src/ws/server.js', () => ({
  roomManager: {
    publish: vi.fn(() => 0),
  },
}));

describe('ISS-195 session-group resume end-to-end', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
  let handleDispatch: typeof import('../../src/jobs/dispatcher.js').handleDispatch;
  let roomManager: { publish: ReturnType<typeof vi.fn> };
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

  const STAGE1_CLI = 'cli-stage1-fixed-uuid';
  const SESSION_GROUP_CONFIG = {
    sessionGroups: { implementation: ['approved', 'developed'] },
    states: {
      approved: { enabled: true, mode: 'manual', sessionGroup: 'implementation' },
      developed: { enabled: true, mode: 'manual', sessionGroup: 'implementation' },
    },
  } as const;

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
    const { bootstrapRunnerAdapters } = await import('../../src/runners/bootstrap.js');
    signUserToken = jwtMod.signUserToken;
    handleDispatch = dispatcherMod.handleDispatch;
    // Register adapters so Test 2's runner-framework path can resolve the
    // `claude-code` adapter via `getRunnerAdapter`. Idempotent.
    bootstrapRunnerAdapters();

    app = new Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/projects', projectRoutes);
    app.route('/api/jobs', jobRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    delete process.env.FEATURE_PIPELINE_CONTROL;
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    roomManager.publish.mockClear();
  });

  // -- helpers ---------------------------------------------------------------

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
    // Online claude-code runner bound to the device so `selectRunnerForJob`
    // resolves it (single runner → picked via the standby step).
    await createTestRunner({
      projectId: project.id,
      deviceId: device.id,
      lastSeenOffsetSeconds: 1,
    });
    const token = await signUserToken(owner.id);
    return { ownerId: owner.id, projectId: project.id, deviceId: device.id, token };
  }

  // Runner cap is 1 in-flight; mark a dispatched job terminal so the next
  // stage's dispatch to the same runner isn't blocked by runner_full.
  async function markJobDone(jobId: string): Promise<void> {
    await harness.db.execute(sql`
      UPDATE jobs SET status = 'done', finished_at = now() WHERE id = ${jobId}
    `);
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

  // Only one issue-kind pipeline_run can be open at a time per issue
  // (pipeline_runs_issue_open_uq, migration 0054). The orchestrator closes
  // the prior run when the issue transitions; tests must mirror that to
  // open a fresh run for stage-2.
  async function closeOpenIssueRun(issueId: string): Promise<void> {
    await harness.db.execute(sql`
      UPDATE pipeline_runs
      SET status = 'completed', finished_at = now()
      WHERE issue_id = ${issueId}
        AND kind = 'issue'
        AND status IN ('running', 'paused')
    `);
  }

  async function insertStageJob(args: {
    projectId: string;
    issueId: string;
    ownerId: string;
    type: 'code' | 'review';
    stageStatus: 'approved' | 'developed';
    sessionGroup?: string;
  }): Promise<string> {
    await closeOpenIssueRun(args.issueId);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (${runId}, ${args.projectId}, ${args.issueId}, 'issue', 'running')
    `);
    const id = randomUUID();
    const payload: Record<string, unknown> = {
      promptString: 'noop',
      stageStatus: args.stageStatus,
    };
    // Real-life: orchestrator stamps sessionGroup on payload at enqueue time
    // from pipelineConfig.states[stage].sessionGroup. Stamp it directly here
    // so the test stays focused on the resolve → resume → dispatch contract.
    if (args.sessionGroup) payload.sessionGroup = args.sessionGroup;
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload, created_by)
      VALUES (
        ${id}, ${args.projectId}, ${args.issueId}, ${runId},
        ${args.type}, 'queued', ${JSON.stringify(payload)}::jsonb, ${args.ownerId}
      )
    `);
    return id;
  }

  // Real life: runner reports `session-started` via PATCH /api/agent-sessions/:id
  // which updates claude_session_id + status. We bypass the runner and write
  // the row directly.
  async function completeAgentSession(
    jobId: string,
    claudeSessionId: string | null,
  ): Promise<void> {
    await harness.db.execute(sql`
      UPDATE agent_sessions
      SET claude_session_id = ${claudeSessionId},
          status = 'completed',
          updated_at = now()
      WHERE id = (SELECT agent_session_id FROM jobs WHERE id = ${jobId})
    `);
  }

  // Failed prior session: claude_session_id is set, status='failed'.
  // `findPriorSessionInGroup` requires status='completed' so this should be
  // skipped by the resume lookup.
  async function failAgentSession(jobId: string, claudeSessionId: string): Promise<void> {
    await harness.db.execute(sql`
      UPDATE agent_sessions
      SET claude_session_id = ${claudeSessionId},
          status = 'failed',
          failure_reason = 'job_failed',
          updated_at = now()
      WHERE id = (SELECT agent_session_id FROM jobs WHERE id = ${jobId})
    `);
  }

  async function readAgentSessionMetadata(jobId: string): Promise<{
    sessionGroup: string | null;
    issueId: string | null;
    deviceId: string | null;
    claudeSessionId: string | null;
    status: string;
  }> {
    const rows = await harness.db.execute<{
      metadata: Record<string, unknown> | null;
      device_id: string | null;
      claude_session_id: string | null;
      status: string;
    }>(sql`
      SELECT s.metadata, s.device_id, s.claude_session_id, s.status
      FROM agent_sessions s
      JOIN jobs j ON j.agent_session_id = s.id
      WHERE j.id = ${jobId}
      LIMIT 1
    `);
    const row = rows[0];
    if (!row) throw new Error(`no agent_session linked to job ${jobId}`);
    const md = (row.metadata ?? {}) as Record<string, unknown>;
    return {
      sessionGroup: (md.sessionGroup as string | undefined) ?? null,
      issueId: (md.issueId as string | undefined) ?? null,
      deviceId: row.device_id,
      claudeSessionId: row.claude_session_id,
      status: row.status,
    };
  }

  async function readJobDeviceId(jobId: string): Promise<string | null> {
    const rows = await harness.db.execute<{ device_id: string | null }>(
      sql`SELECT device_id FROM jobs WHERE id = ${jobId} LIMIT 1`,
    );
    return rows[0]?.device_id ?? null;
  }

  async function readProjectAgentConfig(projectId: string): Promise<Record<string, unknown>> {
    const rows = await harness.db.execute<{ agent_config: Record<string, unknown> | null }>(
      sql`SELECT agent_config FROM projects WHERE id = ${projectId}`,
    );
    return rows[0]?.agent_config ?? {};
  }

  function jobAssignedCalls(): Array<Record<string, unknown>> {
    return roomManager.publish.mock.calls
      .filter((c) => (c[1] as { event?: string } | undefined)?.event === 'job.assigned')
      .map((c) => (c[1] as { data: Record<string, unknown> }).data);
  }

  function lastJobAssignedCall(): Record<string, unknown> {
    const calls = jobAssignedCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // biome-ignore lint/style/noNonNullAssertion: length checked above
    return calls[calls.length - 1]!;
  }

  async function createTestRunner(args: {
    projectId: string;
    deviceId: string;
    lastSeenOffsetSeconds: number;
  }): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, host, device_id, name, capabilities, status, last_seen_at)
      VALUES (
        ${id}, ${args.projectId}, 'claude-code', 'device', ${args.deviceId},
        ${`runner-${id.slice(0, 8)}`},
        ${'{"pm": true}'}::jsonb, 'online',
        now() - (${`${args.lastSeenOffsetSeconds} seconds`})::interval
      )
    `);
    return id;
  }

  // -- tests -----------------------------------------------------------------

  it('stage-2 inherits stage-1 claudeSessionId + sessionGroup on the WS envelope', async () => {
    const { ownerId, projectId, deviceId, token } = await seedOwnerProjectDevice();

    const patchRes = await patchPipelineConfig(projectId, token, SESSION_GROUP_CONFIG);
    expect(patchRes.status).toBe(200);

    const issueId = await insertIssue(projectId, ownerId);

    // Stage 1 — fresh dispatch, no prior session in group yet.
    const jobId1 = await insertStageJob({
      projectId,
      issueId,
      ownerId,
      type: 'code',
      stageStatus: 'approved',
      sessionGroup: 'implementation',
    });
    expect(await handleDispatch({ jobId: jobId1 })).toBe('dispatched');

    const stage1Envelope = lastJobAssignedCall();
    expect(Object.keys(stage1Envelope)).not.toContain('claudeSessionId');
    expect(stage1Envelope.sessionGroup).toBe('implementation');

    const md1 = await readAgentSessionMetadata(jobId1);
    expect(md1.sessionGroup).toBe('implementation');
    expect(md1.issueId).toBe(issueId);
    expect(md1.deviceId).toBe(deviceId);

    // Simulate the runner finishing stage-1 with a stable claudeSessionId.
    await completeAgentSession(jobId1, STAGE1_CLI);
    await markJobDone(jobId1);

    // Stage 2 — same sessionGroup, same issue. Dispatcher should look up the
    // prior session and forward its claudeSessionId on the WS envelope.
    roomManager.publish.mockClear();
    const jobId2 = await insertStageJob({
      projectId,
      issueId,
      ownerId,
      type: 'review',
      stageStatus: 'developed',
      sessionGroup: 'implementation',
    });
    expect(await handleDispatch({ jobId: jobId2 })).toBe('dispatched');

    const stage2Envelope = lastJobAssignedCall();
    // TODO ISS-xxx — once the dispatcher persists claudeSessionId into
    // jobs.payload (PR-7b Inspector follow-up), tighten this to the Inspector
    // envelope below. Today the resume payload is WS-envelope-only.
    expect(stage2Envelope.claudeSessionId).toBe(STAGE1_CLI);
    expect(stage2Envelope.sessionGroup).toBe('implementation');
    expect(stage2Envelope.jobId).toBe(jobId2);
    expect((stage2Envelope.payload as { stageStatus?: unknown }).stageStatus).toBe('developed');

    // Inspector envelope — surfaces persisted payload only (sessionGroup,
    // state). claudeSessionId stays null until PR-7b lands.
    const inspRes = await app.request(`/api/jobs/${jobId2}/prompt`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(inspRes.status).toBe(200);
    const body = (await inspRes.json()) as {
      resolvedFlags: {
        state: string | null;
        sessionGroup: string | null;
        claudeSessionId: string | null;
      };
    };
    expect(body.resolvedFlags.state).toBe('developed');
    expect(body.resolvedFlags.sessionGroup).toBe('implementation');
    expect(body.resolvedFlags.claudeSessionId).toBeNull();
  });

  it("pins stage-2 dispatch to stage-1's device when multiple devices are online", async () => {
    // Two runners on two devices verify `pinDeviceId` routing through
    // `selectRunnerForJob`: stage 2 must land on stage 1's device even after
    // freshness flips to favor the other device.
    {
      const owner = await createTestUser(harness.db);
      await harness.db.execute(
        sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`,
      );
      const project = await createTestProject(harness.db, owner.id);
      const deviceA = await createTestDevice(harness.db, owner.id, { status: 'online' });
      const deviceB = await createTestDevice(harness.db, owner.id, { status: 'online' });
      await harness.db.execute(
        sql`UPDATE devices SET last_seen_at = now() WHERE id IN (${deviceA.id}, ${deviceB.id})`,
      );
      const token = await signUserToken(owner.id);

      // Two runners — device B is freshest, so a fresh dispatch without a pin
      // lands on B. Stage 1 will land on B; stage 2 must override that and
      // land back on B (or wherever stage 1 landed). To prove the pin does
      // real work we flip freshness AFTER stage 1, so the no-pin path would
      // pick device A for stage 2 but the pin should still send it to B.
      const runnerA = await createTestRunner({
        projectId: project.id,
        deviceId: deviceA.id,
        lastSeenOffsetSeconds: 30,
      });
      const runnerB = await createTestRunner({
        projectId: project.id,
        deviceId: deviceB.id,
        lastSeenOffsetSeconds: 1,
      });

      const patchRes = await patchPipelineConfig(project.id, token, SESSION_GROUP_CONFIG);
      expect(patchRes.status).toBe(200);

      const issueId = await insertIssue(project.id, owner.id);
      const jobId1 = await insertStageJob({
        projectId: project.id,
        issueId,
        ownerId: owner.id,
        type: 'code',
        stageStatus: 'approved',
        sessionGroup: 'implementation',
      });
      expect(await handleDispatch({ jobId: jobId1 })).toBe('dispatched');
      const deviceUsed1 = await readJobDeviceId(jobId1);
      expect(deviceUsed1).toBe(deviceB.id);

      await completeAgentSession(jobId1, STAGE1_CLI);
      // Mark stage-1 job terminal so it no longer counts against the
      // runner's in-flight cap (checkLayer4RunnerFull blocks the pinned
      // dispatch otherwise — claude-code default cap is 1).
      await harness.db.execute(sql`
        UPDATE jobs SET status = 'done', finished_at = now() WHERE id = ${jobId1}
      `);

      // Flip freshness so the no-pin path now favors device A. The pin
      // should still send stage 2 to device B (the host that owns the CLI
      // session file).
      await harness.db.execute(sql`
        UPDATE runners SET last_seen_at = now() WHERE id = ${runnerA}
      `);
      // Dispatch liveness tightened to 30s (src/lib/dispatch-liveness.ts), so
      // age runner B only 5s — still fresher-than-A-flipped yet inside the
      // window, so it stays pinnable for stage 2.
      await harness.db.execute(sql`
        UPDATE runners SET last_seen_at = now() - interval '5 seconds' WHERE id = ${runnerB}
      `);

      const jobId2 = await insertStageJob({
        projectId: project.id,
        issueId,
        ownerId: owner.id,
        type: 'review',
        stageStatus: 'developed',
        sessionGroup: 'implementation',
      });
      expect(await handleDispatch({ jobId: jobId2 })).toBe('dispatched');
      const deviceUsed2 = await readJobDeviceId(jobId2);
      expect(deviceUsed2).toBe(deviceUsed1);

      const md1 = await readAgentSessionMetadata(jobId1);
      const md2 = await readAgentSessionMetadata(jobId2);
      expect(md2.deviceId).toBe(md1.deviceId);
    }
  });

  it('failed stage-1 produces no claudeSessionId on stage-2', async () => {
    const { ownerId, projectId, token } = await seedOwnerProjectDevice();
    expect((await patchPipelineConfig(projectId, token, SESSION_GROUP_CONFIG)).status).toBe(200);

    const issueId = await insertIssue(projectId, ownerId);
    const jobId1 = await insertStageJob({
      projectId,
      issueId,
      ownerId,
      type: 'code',
      stageStatus: 'approved',
      sessionGroup: 'implementation',
    });
    expect(await handleDispatch({ jobId: jobId1 })).toBe('dispatched');

    await failAgentSession(jobId1, 'cli-stage1-broken-uuid');
    await markJobDone(jobId1);

    roomManager.publish.mockClear();
    const jobId2 = await insertStageJob({
      projectId,
      issueId,
      ownerId,
      type: 'review',
      stageStatus: 'developed',
      sessionGroup: 'implementation',
    });
    expect(await handleDispatch({ jobId: jobId2 })).toBe('dispatched');

    const envelope = lastJobAssignedCall();
    // `findPriorSessionInGroup` requires status='completed'. A failed prior
    // session is skipped → dispatcher omits the claudeSessionId key entirely
    // (spread guard in dispatcher.ts, not a `null` value).
    expect(Object.keys(envelope)).not.toContain('claudeSessionId');
    // sessionGroup forwarding is independent of resume — still present.
    expect(envelope.sessionGroup).toBe('implementation');
  });

  it('completed stage-1 with null claudeSessionId produces no claudeSessionId on stage-2', async () => {
    // Cancellation path: agent_sessions has no `cancelled` enum value;
    // `syncAgentSessionLifecycle` maps cancel → 'completed'. If the worker
    // never reported a claudeSessionId before the cancel landed, the row is
    // status='completed' with claude_session_id IS NULL. The resume lookup's
    // isNotNull(claudeSessionId) guard should skip it.
    const { ownerId, projectId, token } = await seedOwnerProjectDevice();
    expect((await patchPipelineConfig(projectId, token, SESSION_GROUP_CONFIG)).status).toBe(200);

    const issueId = await insertIssue(projectId, ownerId);
    const jobId1 = await insertStageJob({
      projectId,
      issueId,
      ownerId,
      type: 'code',
      stageStatus: 'approved',
      sessionGroup: 'implementation',
    });
    expect(await handleDispatch({ jobId: jobId1 })).toBe('dispatched');
    await completeAgentSession(jobId1, null);
    await markJobDone(jobId1);

    roomManager.publish.mockClear();
    const jobId2 = await insertStageJob({
      projectId,
      issueId,
      ownerId,
      type: 'review',
      stageStatus: 'developed',
      sessionGroup: 'implementation',
    });
    expect(await handleDispatch({ jobId: jobId2 })).toBe('dispatched');

    const envelope = lastJobAssignedCall();
    expect(Object.keys(envelope)).not.toContain('claudeSessionId');
    expect(envelope.sessionGroup).toBe('implementation');
  });

  it('ISS-580: bound exceeded (maxResumeTokens) → fresh dispatch on stage-2', async () => {
    const { ownerId, projectId, token } = await seedOwnerProjectDevice();

    // Configure maxResumeTokens=100 so any real usage record pushes over.
    const patchRes = await patchPipelineConfig(projectId, token, {
      ...SESSION_GROUP_CONFIG,
      maxResumeTokens: 100,
    });
    expect(patchRes.status).toBe(200);

    const issueId = await insertIssue(projectId, ownerId);
    const jobId1 = await insertStageJob({
      projectId,
      issueId,
      ownerId,
      type: 'code',
      stageStatus: 'approved',
      sessionGroup: 'implementation',
    });
    expect(await handleDispatch({ jobId: jobId1 })).toBe('dispatched');
    await completeAgentSession(jobId1, STAGE1_CLI);

    // Seed a usage_records row for this session with tokens > threshold.
    // session_id is text; its value is the uuid of the agent_session row.
    // This exercises the `session_id::uuid = s.id` cast fix.
    const agentSessionRows = await harness.db.execute<{ id: string }>(
      sql`SELECT id FROM agent_sessions WHERE id = (SELECT agent_session_id FROM jobs WHERE id = ${jobId1}) LIMIT 1`,
    );
    const agentSessionId = agentSessionRows[0]?.id;
    expect(agentSessionId).toBeTruthy();

    await harness.db.execute(sql`
      INSERT INTO usage_records
        (id, project_id, source, model, input_tokens, cache_read_tokens, estimated_cost, recorded_at, session_id)
      VALUES
        (${randomUUID()}, ${projectId}, 'api', 'claude-3-5-sonnet', 200, 0, 0.001, now(), ${agentSessionId})
    `);

    await markJobDone(jobId1);

    roomManager.publish.mockClear();
    const jobId2 = await insertStageJob({
      projectId,
      issueId,
      ownerId,
      type: 'review',
      stageStatus: 'developed',
      sessionGroup: 'implementation',
    });
    expect(await handleDispatch({ jobId: jobId2 })).toBe('dispatched');

    // Bound exceeded → fresh dispatch → claudeSessionId NOT forwarded.
    const envelope = lastJobAssignedCall();
    expect(Object.keys(envelope)).not.toContain('claudeSessionId');
    expect(envelope.sessionGroup).toBe('implementation');
  });

  it('removing sessionGroups config mid-flight breaks the resume chain', async () => {
    const { ownerId, projectId, token } = await seedOwnerProjectDevice();
    expect((await patchPipelineConfig(projectId, token, SESSION_GROUP_CONFIG)).status).toBe(200);

    const issueId = await insertIssue(projectId, ownerId);
    const jobId1 = await insertStageJob({
      projectId,
      issueId,
      ownerId,
      type: 'code',
      stageStatus: 'approved',
      sessionGroup: 'implementation',
    });
    expect(await handleDispatch({ jobId: jobId1 })).toBe('dispatched');
    await completeAgentSession(jobId1, STAGE1_CLI);
    await markJobDone(jobId1);

    // Wipe the session-group binding. `updatePipelineConfig` shallow-merges
    // at the pipelineConfig level — sending `states.<x>` without
    // `sessionGroup` replaces the whole entry. `sessionGroups: {}` clears
    // the top-level binding so the validator can't surface a "sessionGroup
    // not declared" cross-field error.
    const revertRes = await patchPipelineConfig(projectId, token, {
      sessionGroups: {},
      states: {
        approved: { enabled: true, mode: 'manual' },
        developed: { enabled: true, mode: 'manual' },
      },
    });
    expect(revertRes.status).toBe(200);

    const stored = await readProjectAgentConfig(projectId);
    const pc = stored.pipelineConfig as
      | {
          sessionGroups?: Record<string, unknown>;
          states?: { developed?: Record<string, unknown> };
        }
      | undefined;
    expect(Object.keys(pc?.sessionGroups ?? {})).toHaveLength(0);
    expect(Object.keys(pc?.states?.developed ?? {})).not.toContain('sessionGroup');

    roomManager.publish.mockClear();
    // Stage 2 — orchestrator-in-real-life would NOT stamp sessionGroup with
    // the config cleared, so we omit it from the synthetic payload too.
    const jobId2 = await insertStageJob({
      projectId,
      issueId,
      ownerId,
      type: 'review',
      stageStatus: 'developed',
    });
    expect(await handleDispatch({ jobId: jobId2 })).toBe('dispatched');

    const envelope = lastJobAssignedCall();
    expect(Object.keys(envelope)).not.toContain('claudeSessionId');
    expect(Object.keys(envelope)).not.toContain('sessionGroup');

    const inspRes = await app.request(`/api/jobs/${jobId2}/prompt`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(inspRes.status).toBe(200);
    const body = (await inspRes.json()) as {
      resolvedFlags: { sessionGroup: string | null; claudeSessionId: string | null };
    };
    expect(body.resolvedFlags.sessionGroup).toBeNull();
    expect(body.resolvedFlags.claudeSessionId).toBeNull();
  });
});

// ISS-580 — direct SQL verification of estimateGroupContextTokens.
// Unit tests mock db.execute so the text→uuid cast never ran against Postgres.
// This suite hits real PG to confirm the fix doesn't regress.
describe('ISS-580 estimateGroupContextTokens — real-PG SQL verification', () => {
  let harness: TestDatabase;
  let estimateGroupContextTokens: (args: {
    issueId: string;
    sessionGroup: string;
  }) => Promise<number>;

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

    const mod = await import('../../src/jobs/session-resume.js');
    estimateGroupContextTokens = mod.estimateGroupContextTokens;
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  it('returns 0 when no usage_records exist for the group', async () => {
    const tokens = await estimateGroupContextTokens({ issueId: randomUUID(), sessionGroup: 'impl' });
    expect(tokens).toBe(0);
  });

  it('returns the MAX(input_tokens + cache_read_tokens) across sessions (verifies text::uuid cast)', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const issueId = randomUUID();

    // Insert two agent_sessions in the same (issueId, sessionGroup).
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    for (const [sid, issId, group, claudeId] of [
      [sessionA, issueId, 'impl', 'cli-a'],
      [sessionB, issueId, 'impl', 'cli-b'],
    ] as const) {
      await harness.db.execute(sql`
        INSERT INTO agent_sessions
          (id, project_id, status, metadata, claude_session_id, created_at, updated_at)
        VALUES (
          ${sid}::uuid, ${project.id}::uuid, 'completed',
          ${JSON.stringify({ issueId: issId, sessionGroup: group })}::jsonb,
          ${claudeId}, now(), now()
        )
      `);
    }

    // Session A: 5000 input + 3000 cache_read = 8000
    // Session B: 12000 input + 0 cache_read = 12000
    // Expected MAX = 12000
    await harness.db.execute(sql`
      INSERT INTO usage_records
        (id, project_id, source, model, input_tokens, cache_read_tokens, estimated_cost, recorded_at, session_id)
      VALUES
        (${randomUUID()}, ${project.id}::uuid, 'api', 'sonnet', 5000, 3000, 0.01, now(), ${sessionA}),
        (${randomUUID()}, ${project.id}::uuid, 'api', 'sonnet', 12000, 0, 0.02, now(), ${sessionB})
    `);

    const tokens = await estimateGroupContextTokens({ issueId, sessionGroup: 'impl' });
    expect(tokens).toBe(12000);
  });

  it('ignores sessions where claude_session_id IS NULL (partial index predicate)', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const issueId = randomUUID();

    // Session with no claude_session_id — should be excluded by the predicate.
    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions
        (id, project_id, status, metadata, claude_session_id, created_at, updated_at)
      VALUES (
        ${sessionId}::uuid, ${project.id}::uuid, 'completed',
        ${JSON.stringify({ issueId, sessionGroup: 'impl' })}::jsonb,
        NULL, now(), now()
      )
    `);
    await harness.db.execute(sql`
      INSERT INTO usage_records
        (id, project_id, source, model, input_tokens, cache_read_tokens, estimated_cost, recorded_at, session_id)
      VALUES
        (${randomUUID()}, ${project.id}::uuid, 'api', 'sonnet', 99999, 0, 0.1, now(), ${sessionId})
    `);

    const tokens = await estimateGroupContextTokens({ issueId, sessionGroup: 'impl' });
    expect(tokens).toBe(0);
  });
});
