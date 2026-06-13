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
//   2. A plan job runs; agent writes handoff via POST /api/issue-step-contexts,
//      then reports completion with `summary: "...DONE"` via /api/jobs/:id/complete.
//   3. Job finalizes as `done` on a clean exit (exitCode 0).
//   4. Variant: agent emits DONE WITHOUT writing the row — job still finalizes
//      as `done`. Handoff is best-effort context, NOT a server-side status
//      gate (see lifecycle-routes.ts / finalize-done.ts).
//   5. Variant: agent emits HANDOFF_GIVE_UP with a clean exit — still `done`;
//      the trailing marker is not interpreted server-side.

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

    const { stepHandoffRoutes } = await import('../../src/pipeline/step-handoff-routes.js');
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
    app.route('/api/issue-step-contexts', stepHandoffRoutes);
    app.route('/api/jobs', jobLifecycleDeviceRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    // Step handoffs no longer route through embeddings; the stub is harmless
    // but kept for defence-in-depth in case a test pulls in memory paths.
    const fake = {
      embed: vi.fn(async () => hotVector(0)),
      embedBatch: vi.fn(async () => [hotVector(0)]),
      resetBreaker: () => undefined,
    };
    embeddingsMod.resetEmbeddingsClient(
      fake as unknown as InstanceType<typeof embeddingsMod.EmbeddingsClient>,
    );
  });

  async function seedProjectWithHandoffsEnabled(
    opts: {
      missingMarkerPolicy?: 'fail' | 'warn' | 'silent';
    } = {},
  ) {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
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
        (SELECT created_by FROM projects WHERE id = ${args.projectId}))
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
        (SELECT created_by FROM projects WHERE id = ${args.projectId}),
        1, now(),
        ${JSON.stringify({ stageStatus: 'approved' })}::jsonb
      )
    `);
    return { jobId, runId, issueId };
  }

  // ---------- Happy path ----------

  it('writes handoff + emits DONE → job finalizes as done', async () => {
    const { projectId, userToken, device, deviceToken } = await seedProjectWithHandoffsEnabled();
    const { jobId, runId, issueId } = await createPipelineRunAndJob({
      projectId,
      deviceId: device.id,
    });

    // Step 1 — agent writes the handoff row via the new endpoint.
    const writeRes = await app.request('/api/issue-step-contexts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        projectId,
        issueId,
        pipelineRunId: runId,
        step: 'plan',
        attempt: 1,
        payload: {
          step: 'plan',
          schema_version: 1,
          planSummary: 'Fix Safari ITP cookie handling',
          affectedFiles: ['src/auth/cookie.ts'],
          acceptanceChecklist: ['safari login passes'],
          unknowns: [],
        },
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

  // ---------- DONE without write — handoff is NOT a status gate ----------

  // Step-handoff is best-effort context for the next step, deliberately NOT a
  // server-side completion gate (lifecycle-routes.ts: exitCode 0 → done;
  // finalize-done.ts comment "handoff is not a status gate"). A clean exit
  // finalizes the job as `done` even when the agent skipped the handoff write —
  // the next step falls back to raw issue fields. (Was previously asserted to
  // fail with failureKind='handoff_not_written'; that gating was removed.)
  it('emits DONE WITHOUT writing the handoff → still finalizes as done (no failure stamp)', async () => {
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
    expect(rows[0]?.status).toBe('done');
    expect(rows[0]?.failure_kind).toBeNull();
    expect(rows[0]?.failure_reason).toBeNull();
  });

  // ---------- HANDOFF_GIVE_UP marker — also NOT a status gate ----------

  // The HANDOFF_GIVE_UP marker is no longer interpreted server-side; a clean
  // exitCode 0 still finalizes as `done` regardless of the summary's trailing
  // marker. (Was previously asserted to fail with handoff_validation_failed.)
  it('emits HANDOFF_GIVE_UP with exitCode 0 → still finalizes as done (marker not gated)', async () => {
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
      sql`SELECT status, failure_kind, failure_reason FROM jobs WHERE id = ${jobId}`,
    );
    expect(rows[0]?.status).toBe('done');
    expect(rows[0]?.failure_kind).toBeNull();
    expect(rows[0]?.failure_reason).toBeNull();
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

    const rows = await harness.db.execute(sql`SELECT status FROM jobs WHERE id = ${jobId}`);
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
        (SELECT created_by FROM projects WHERE id = ${projectId}))
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
        (SELECT created_by FROM projects WHERE id = ${projectId}),
        1, now(), ${JSON.stringify({ stageStatus: 'approved' })}::jsonb)
    `);

    const res = await app.request(`/api/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ exitCode: 0, summary: 'no marker, no row' }),
    });
    expect(res.status).toBe(200);

    const rows = await harness.db.execute(sql`SELECT status FROM jobs WHERE id = ${jobId}`);
    expect(rows[0]?.status).toBe('done');
  });
});
