import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  type TestDatabase,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// End-to-end coverage for step-handoff (proposal Y).
// Exercises the full happy + sad paths:
//   1. Project config opts into handoffs for stage 'approved' / step 'plan'.
//   2. A plan job runs; agent writes handoff via POST /api/memory, then
//      reports completion with `summary: "...DONE"` via /api/jobs/:id/complete.
//   3. The lifecycle hook (verifyHandoffOrSkip) confirms the row + flips job
//      to `done`.
//   4. Variant: agent emits DONE WITHOUT writing the row — job flips to
//      `failed` with failureKind='handoff_not_written'.
//   5. Variant: agent emits HANDOFF_GIVE_UP — flips to failed with
//      handoff_validation_failed.

const DIM = 1536;

function hotVector(idx: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[idx] = 1;
  return v;
}

describe('step-handoff lifecycle flow (proposal Y)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  let embeddingsMod: typeof import('../../src/embeddings/index.js');
  let issueDeviceToken: typeof import('../../src/auth/deviceToken.js').issueDeviceToken;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';
    process.env.EMBEDDINGS_BASE_URL ??= 'https://stub.invalid';
    process.env.EMBEDDINGS_API_KEY ??= 'stub-key';

    const { memoryWriteRoutes } = await import('../../src/memory/write-routes.js');
    const { jobLifecycleDeviceRoutes } = await import('../../src/jobs/lifecycle-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    embeddingsMod = await import('../../src/embeddings/index.js');
    signUserToken = jwtMod.signUserToken;
    const deviceTokenMod = await import('../../src/auth/deviceToken.js');
    issueDeviceToken = deviceTokenMod.issueDeviceToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/memory', memoryWriteRoutes);
    app.route('/api/jobs', jobLifecycleDeviceRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    // Stub embeddings so POST /api/memory works without a live LiteLLM proxy.
    const fake = {
      embed: vi.fn(async () => hotVector(0)),
      embedBatch: vi.fn(async () => [hotVector(0)]),
      resetBreaker: () => undefined,
    };
    embeddingsMod.resetEmbeddingsClient(
      fake as unknown as InstanceType<typeof embeddingsMod.EmbeddingsClient>,
    );
  });

  async function seedProjectWithHandoffsEnabled(opts: {
    missingMarkerPolicy?: 'fail' | 'warn' | 'silent';
  } = {}) {
    const user = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`,
    );
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'owner',
    });
    // Inject the handoff policy onto the project's agentConfig — the
    // verifier reads it from the same path the prompt builder consumes.
    const agentConfig = JSON.stringify({
      pipelineConfig: {
        states: {
          approved: {
            userPromptPolicy: {
              handoffs: {
                enabled: true,
                requireHandoffWrite: true,
                injectFromSteps: ['triage'],
                missingMarkerPolicy: opts.missingMarkerPolicy ?? 'fail',
              },
            },
          },
        },
      },
    });
    await harness.db.execute(sql`
      UPDATE projects
      SET agent_config = ${agentConfig}::jsonb
      WHERE id = ${project.id}
    `);
    const userToken = await signUserToken(user.id);
    const issued = await issueDeviceToken({
      ownerId: user.id,
      name: 'test-device',
      platform: 'linux',
    });
    return {
      userId: user.id,
      projectId: project.id,
      userToken,
      device: issued.device,
      deviceToken: issued.plaintext,
    };
  }

  async function createPipelineRunAndJob(args: {
    projectId: string;
    deviceId: string;
    type?: 'plan' | 'code' | 'triage' | 'review' | 'test' | 'fix';
  }) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const jobId = randomUUID();
    const jobType = args.type ?? 'plan';

    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, priority, created_by_id)
      VALUES (${issueId}, ${args.projectId}, 'test issue', 'approved', 'medium',
        (SELECT owner_id FROM projects WHERE id = ${args.projectId}))
    `);
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, current_step)
      VALUES (${runId}, ${args.projectId}, ${issueId}, 'issue', 'running', ${jobType})
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, pipeline_run_id, type, status,
        device_id, created_by, attempts, dispatched_at, payload
      ) VALUES (
        ${jobId}, ${args.projectId}, ${issueId}, ${runId}, ${jobType}, 'running',
        ${args.deviceId},
        (SELECT owner_id FROM projects WHERE id = ${args.projectId}),
        1, now(),
        ${JSON.stringify({ stageStatus: 'approved' })}::jsonb
      )
    `);
    return { jobId, runId, issueId };
  }

  // ---------- Happy path ----------

  it('writes handoff + emits DONE → job finalizes as done', async () => {
    const { projectId, userToken, device, deviceToken } = await seedProjectWithHandoffsEnabled();
    const { jobId, runId } = await createPipelineRunAndJob({
      projectId,
      deviceId: device.id,
    });

    // Step 1 — agent writes the handoff row.
    const writeRes = await app.request('/api/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        projectId,
        source: 'step_handoff',
        sourceRef: `run:${runId}/step:plan/attempt:1`,
        textContent: JSON.stringify({
          step: 'plan',
          schema_version: 1,
          planSummary: 'Fix Safari ITP cookie handling',
          affectedFiles: ['src/auth/cookie.ts'],
          acceptanceChecklist: ['safari login passes'],
          unknowns: [],
        }),
        metadata: { run_id: runId, step: 'plan', attempt: 1 },
      }),
    });
    expect(writeRes.status).toBe(201);

    // Step 2 — agent reports complete with last-text="DONE".
    const completeRes = await app.request(`/api/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({ exitCode: 0, summary: 'work body...\n\nDONE' }),
    });
    expect(completeRes.status).toBe(200);

    const rows = await harness.db.execute(
      sql`SELECT status, failure_kind, failure_reason FROM jobs WHERE id = ${jobId}`,
    );
    expect(rows[0]?.status).toBe('done');
    expect(rows[0]?.failure_kind).toBeNull();
  });

  // ---------- Sad path: DONE without write ----------

  it('emits DONE WITHOUT writing → flips to failed (handoff_not_written)', async () => {
    const { projectId, device, deviceToken } = await seedProjectWithHandoffsEnabled();
    const { jobId } = await createPipelineRunAndJob({ projectId, deviceId: device.id });

    // Skip the write — go straight to /complete.
    const completeRes = await app.request(`/api/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({ exitCode: 0, summary: 'done\n\nDONE' }),
    });
    expect(completeRes.status).toBe(200);

    const rows = await harness.db.execute(
      sql`SELECT status, failure_kind, failure_reason FROM jobs WHERE id = ${jobId}`,
    );
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.failure_kind).toBe('permanent');
    expect(String(rows[0]?.failure_reason)).toMatch(/handoff_not_written/);
  });

  // ---------- Sad path: HANDOFF_GIVE_UP ----------

  it('emits HANDOFF_GIVE_UP → flips to failed (handoff_validation_failed)', async () => {
    const { projectId, device, deviceToken } = await seedProjectWithHandoffsEnabled();
    const { jobId } = await createPipelineRunAndJob({ projectId, deviceId: device.id });

    const completeRes = await app.request(`/api/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({
        exitCode: 0,
        summary: 'I tried three times\n\nHANDOFF_GIVE_UP',
      }),
    });
    expect(completeRes.status).toBe(200);

    const rows = await harness.db.execute(
      sql`SELECT status, failure_reason FROM jobs WHERE id = ${jobId}`,
    );
    expect(rows[0]?.status).toBe('failed');
    expect(String(rows[0]?.failure_reason)).toMatch(/handoff_validation_failed/);
  });

  // ---------- Missing marker + policy=warn ----------

  it('missing marker + missingMarkerPolicy=warn → finalizes as done (rollout-safe)', async () => {
    const { projectId, device, deviceToken } = await seedProjectWithHandoffsEnabled({
      missingMarkerPolicy: 'warn',
    });
    const { jobId } = await createPipelineRunAndJob({ projectId, deviceId: device.id });

    const completeRes = await app.request(`/api/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({ exitCode: 0, summary: 'agent forgot the marker' }),
    });
    expect(completeRes.status).toBe(200);

    const rows = await harness.db.execute(
      sql`SELECT status FROM jobs WHERE id = ${jobId}`,
    );
    expect(rows[0]?.status).toBe('done');
  });

  // ---------- Non-handoff step exempt ----------

  it('clarify step is exempt from handoff verification', async () => {
    const { projectId, device, deviceToken } = await seedProjectWithHandoffsEnabled();
    // Direct insert: clarify isn't in HANDOFF_STEPS, so policy doesn't apply.
    const issueId = randomUUID();
    const runId = randomUUID();
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, title, status, priority, created_by_id)
      VALUES (${issueId}, ${projectId}, 't', 'approved', 'medium',
        (SELECT owner_id FROM projects WHERE id = ${projectId}))
    `);
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, current_step)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'running', 'clarify')
    `);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status,
        device_id, created_by, attempts, dispatched_at, payload)
      VALUES (${jobId}, ${projectId}, ${issueId}, ${runId}, 'clarify', 'running',
        ${device.id},
        (SELECT owner_id FROM projects WHERE id = ${projectId}),
        1, now(), ${JSON.stringify({ stageStatus: 'approved' })}::jsonb)
    `);

    const res = await app.request(`/api/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ exitCode: 0, summary: 'no marker, no row' }),
    });
    expect(res.status).toBe(200);

    const rows = await harness.db.execute(
      sql`SELECT status FROM jobs WHERE id = ${jobId}`,
    );
    expect(rows[0]?.status).toBe('done');
  });
});
