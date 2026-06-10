import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  type TestDatabase,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// W2.1.2 integration — GET /api/jobs/:id/prompt envelope, redaction, and
// access control. Snapshot columns are populated by hand here (the dispatcher
// path that writes them lives behind W2.1.1 on a sibling branch); the route
// is a pure read, so a hand-seeded row exercises every code path.

interface SeedJobOpts {
  projectId: string;
  ownerId: string;
  issueId?: string | null;
  systemPromptHash?: string | null;
  userPromptSnapshot?: string | null;
  promptBlocks?: unknown;
  promptInputTokenEst?: number | null;
  modelUsed?: string | null;
  agentSessionId?: string | null;
  archivePath?: string | null;
  payload?: Record<string, unknown>;
}

describe('GET /api/jobs/:id/prompt (W2.1.2)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

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

    const { jobRoutes } = await import('../../src/jobs/routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    const jwtMod = await import('../../src/auth/jwt.js');
    signUserToken = jwtMod.signUserToken;

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/jobs', jobRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedUserProject(role: 'admin' | 'member' | 'viewer' = 'admin') {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role,
    });
    return { user, project };
  }

  async function seedPromptBlob(content: string): Promise<string> {
    const hash = createHash('sha256').update(content).digest('hex');
    await harness.db.execute(sql`
      INSERT INTO prompt_blobs (hash, content, ref_count)
      VALUES (${hash}, ${content}, 1)
      ON CONFLICT (hash) DO UPDATE SET ref_count = prompt_blobs.ref_count + 1
    `);
    return hash;
  }

  async function seedJob(opts: SeedJobOpts): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status)
      VALUES (
        ${runId}, ${opts.projectId}, ${opts.issueId ?? null},
        ${opts.issueId ? 'issue' : 'system'}, 'running'
      )
    `);
    const jobId = randomUUID();
    const payloadJson = JSON.stringify(opts.payload ?? {});
    const blocksJson = opts.promptBlocks === undefined ? null : JSON.stringify(opts.promptBlocks);
    await harness.db.execute(sql`
      INSERT INTO jobs (
        id, project_id, issue_id, pipeline_run_id, created_by, type, payload, status,
        agent_session_id, system_prompt_hash, user_prompt_snapshot,
        prompt_input_token_est, model_used, prompt_blocks, archive_path
      )
      VALUES (
        ${jobId}, ${opts.projectId}, ${opts.issueId ?? null}, ${runId}, ${opts.ownerId},
        'triage', ${payloadJson}::jsonb, 'succeeded',
        ${opts.agentSessionId ?? null},
        ${opts.systemPromptHash ?? null},
        ${opts.userPromptSnapshot ?? null},
        ${opts.promptInputTokenEst ?? null},
        ${opts.modelUsed ?? null},
        ${blocksJson === null ? sql`NULL` : sql`${blocksJson}::jsonb`},
        ${opts.archivePath ?? null}
      )
    `);
    return jobId;
  }

  async function getPrompt(jobId: string, token: string) {
    return app.request(`/api/jobs/${jobId}/prompt`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it('returns full envelope for a job with snapshot columns populated', async () => {
    const { user, project } = await seedUserProject('admin');
    const systemHash = await seedPromptBlob('# PIPELINE_RULES\nbe excellent');
    const sessionUuid = randomUUID();
    const jobId = await seedJob({
      projectId: project.id,
      ownerId: user.id,
      systemPromptHash: systemHash,
      userPromptSnapshot: '/forge-triage iss-1\n\n## Issue\nTitle: foo',
      promptBlocks: [
        { id: 'system', chars: 30 },
        { id: 'user', chars: 42 },
      ],
      promptInputTokenEst: 256,
      modelUsed: 'claude-opus-4-7',
      agentSessionId: sessionUuid,
      payload: {
        promptString: '/forge-triage iss-1',
        skillName: 'forge-triage',
        preventiveContext: { hint: 'see ISS-42' },
      },
    });

    const token = await signUserToken(user.id);
    const res = await getPrompt(jobId, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobId: string;
      systemPrompt: string;
      systemPromptHash: string | null;
      userPrompt: string;
      blocks: unknown[];
      estTokens: { input: number | null };
      actualUsage: unknown;
      mcpConfig: unknown;
      model: string;
      payloadExtras: Record<string, unknown>;
    };

    expect(body.jobId).toBe(jobId);
    expect(body.systemPrompt).toBe('# PIPELINE_RULES\nbe excellent');
    expect(body.systemPromptHash).toBe(systemHash);
    expect(body.userPrompt).toBe('/forge-triage iss-1\n\n## Issue\nTitle: foo');
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks.length).toBe(2);
    expect(body.estTokens.input).toBe(256);
    expect(body.model).toBe('claude-opus-4-7');
    expect(body.mcpConfig).toBeNull();
    expect(body.actualUsage).toBeNull();
    expect(body.payloadExtras).toEqual({ preventiveContext: { hint: 'see ISS-42' } });
    expect(Object.keys(body.payloadExtras)).not.toContain('promptString');
    expect(Object.keys(body.payloadExtras)).not.toContain('skillName');
    expect(Object.keys(body.payloadExtras)).not.toContain('mcpServers');
  });

  it('returns 403 when the caller is not a project member', async () => {
    const { user: owner, project } = await seedUserProject('admin');
    const stranger = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
    );

    const systemHash = await seedPromptBlob('preamble');
    const jobId = await seedJob({
      projectId: project.id,
      ownerId: owner.id,
      systemPromptHash: systemHash,
      userPromptSnapshot: 'body',
    });

    const token = await signUserToken(stranger.id);
    const res = await getPrompt(jobId, token);
    expect(res.status).toBe(403);
  });

  it('returns 404 when the job has no snapshot (pre-W2.1.1)', async () => {
    const { user, project } = await seedUserProject('admin');
    const jobId = await seedJob({
      projectId: project.id,
      ownerId: user.id,
      systemPromptHash: null,
      userPromptSnapshot: null,
    });
    const token = await signUserToken(user.id);
    const res = await getPrompt(jobId, token);
    expect(res.status).toBe(404);
  });

  it('returns 410 with {archived,path} when archive_path is set and snapshot is empty', async () => {
    const { user, project } = await seedUserProject('admin');
    const jobId = await seedJob({
      projectId: project.id,
      ownerId: user.id,
      systemPromptHash: null,
      userPromptSnapshot: null,
      archivePath: 's3://forge-archive/jobs/abc',
    });
    const token = await signUserToken(user.id);
    const res = await getPrompt(jobId, token);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { archived: boolean; path: string };
    expect(body.archived).toBe(true);
    expect(body.path).toBe('s3://forge-archive/jobs/abc');
  });

  it('redacts Authorization / X-Device-Token / Cookie headers in mcpServers', async () => {
    const { user, project } = await seedUserProject('admin');
    const systemHash = await seedPromptBlob('preamble');
    const auth = 'Bearer secret-token-123';
    const deviceTok = 'dt-456';
    const cookie = 'session=foo';
    const jobId = await seedJob({
      projectId: project.id,
      ownerId: user.id,
      systemPromptHash: systemHash,
      userPromptSnapshot: 'body',
      payload: {
        mcpServers: [
          {
            url: 'https://x',
            headers: {
              Authorization: auth,
              'X-Device-Token': deviceTok,
              Cookie: cookie,
            },
          },
        ],
      },
    });

    const token = await signUserToken(user.id);
    const res = await getPrompt(jobId, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('secret-token-123');
    expect(raw).not.toContain('dt-456');
    expect(raw).not.toContain('session=foo');

    const headers = (body as { mcpConfig: Array<{ headers: Record<string, string> }> })
      .mcpConfig[0]!.headers;
    expect(headers.Authorization).toBe(`[REDACTED ${auth.length} chars]`);
    expect(headers['X-Device-Token']).toBe(`[REDACTED ${deviceTok.length} chars]`);
    expect(headers.Cookie).toBe(`[REDACTED ${cookie.length} chars]`);
  });

  it('actualUsage is null when agentSessionId is set but no usage_records match', async () => {
    const { user, project } = await seedUserProject('admin');
    const systemHash = await seedPromptBlob('preamble');
    const jobId = await seedJob({
      projectId: project.id,
      ownerId: user.id,
      systemPromptHash: systemHash,
      userPromptSnapshot: 'body',
      agentSessionId: randomUUID(),
    });
    const token = await signUserToken(user.id);
    const res = await getPrompt(jobId, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actualUsage: unknown };
    expect(body.actualUsage).toBeNull();
  });

  it('actualUsage sums usage_records rows joined by session_id::uuid = job.id', async () => {
    const { user, project } = await seedUserProject('admin');
    const systemHash = await seedPromptBlob('preamble');
    const jobId = await seedJob({
      projectId: project.id,
      ownerId: user.id,
      systemPromptHash: systemHash,
      userPromptSnapshot: 'body',
      agentSessionId: randomUUID(),
    });
    // Two usage_records rows tagged with session_id = job.id.
    for (const row of [
      { input: 100, output: 50, cacheRead: 10, cacheCreate: 5, cost: 0.001, count: 1 },
      { input: 200, output: 75, cacheRead: 20, cacheCreate: 7, cost: 0.002, count: 1 },
    ]) {
      await harness.db.execute(sql`
        INSERT INTO usage_records (
          id, project_id, source, model, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, estimated_cost,
          request_count, session_id, recorded_at
        )
        VALUES (
          ${randomUUID()}, ${project.id}, 'cli', 'claude-opus-4-7',
          ${row.input}, ${row.output}, ${row.cacheRead}, ${row.cacheCreate},
          ${row.cost}, ${row.count}, ${jobId}, now()
        )
      `);
    }

    const token = await signUserToken(user.id);
    const res = await getPrompt(jobId, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      actualUsage: {
        input: number;
        output: number;
        cached: number;
        cacheCreation: number;
        cost: number;
        count: number;
      };
    };
    expect(body.actualUsage.input).toBe(300);
    expect(body.actualUsage.output).toBe(125);
    expect(body.actualUsage.cached).toBe(30);
    expect(body.actualUsage.cacheCreation).toBe(12);
    expect(body.actualUsage.count).toBe(2);
    expect(body.actualUsage.cost).toBeCloseTo(0.003, 5);
  });

  it('returns 401 without an Authorization header', async () => {
    const { user, project } = await seedUserProject('admin');
    const systemHash = await seedPromptBlob('preamble');
    const jobId = await seedJob({
      projectId: project.id,
      ownerId: user.id,
      systemPromptHash: systemHash,
      userPromptSnapshot: 'body',
    });
    const res = await app.request(`/api/jobs/${jobId}/prompt`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown job id', async () => {
    const { user } = await seedUserProject('admin');
    const token = await signUserToken(user.id);
    const res = await getPrompt(randomUUID(), token);
    expect(res.status).toBe(404);
  });
});
