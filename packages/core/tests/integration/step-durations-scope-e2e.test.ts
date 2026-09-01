/**
 * `GET /api/pipeline/step-durations` sees only the caller's projects.
 *
 * ISS-894 wave 3 — rebuilt from `forge_metrics.step_durations`'s unit test
 * before that tool was deleted. The original asserted on generated SQL text
 * (`IN (` present, `ANY(` and `::uuid[]` absent) because it ran against a
 * mocked drizzle and could not execute anything. Real Postgres decides the
 * same question by answering it: a binding that regresses to `ANY(::uuid[])`
 * either errors or returns the wrong rows here, and no assertion has to know
 * which SQL was generated to catch it.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
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

  const [analytics, jwt, err] = await Promise.all([
    import('../../src/pipeline/analytics-routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  signUserToken = jwt.signUserToken;
  app = new Hono();
  app.route('/api/pipeline', analytics.pipelineAnalyticsRoutes);
  app.onError(err.errorHandler);
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function seedProjectWithOneStep(step: string) {
  const owner = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  const project = await createTestProject(harness.db, owner.id);
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${project.id}, 1, 'scope fixture', 'open', ${owner.id})`);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
    VALUES (${runId}, ${project.id}, ${issueId}, 'issue', 'completed', now())`);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload,
                      created_by, queued_at, dispatched_at, finished_at)
    VALUES (${randomUUID()}, ${project.id}, ${issueId}, ${runId}, ${step}, 'done', '{}'::jsonb,
            ${owner.id}, now() - make_interval(mins => 6),
            now() - make_interval(mins => 5), now())`);
  return { owner, project, token: await signUserToken(owner.id) };
}

describe('GET /api/pipeline/step-durations', () => {
  // cm:guard the second project is the whole test: with ONE project seeded, a route that ignored visibility entirely would return the same rows and pass. The failure being guarded is one account reading another's pipeline timings, and it takes a row that must NOT come back to see it.
  it('returns the caller own step rows and none from a project they cannot see', async () => {
    const mine = await seedProjectWithOneStep('code');
    const theirs = await seedProjectWithOneStep('review');

    const res = await app.request('/api/pipeline/step-durations?days=30', {
      headers: { authorization: `Bearer ${mine.token}` },
    });
    expect(res.status).toBe(200);

    const rows = (await res.json()) as Array<{ projectId: string; step: string }>;
    expect(rows.map((r) => r.step)).toEqual(['code']);
    expect(rows.every((r) => r.projectId === mine.project.id)).toBe(true);
    expect(rows.some((r) => r.projectId === theirs.project.id)).toBe(false);
  });

  it('answers an empty list, not an error, for a caller with no projects at all', async () => {
    await seedProjectWithOneStep('code');
    const stranger = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
    );

    const res = await app.request('/api/pipeline/step-durations?days=30', {
      headers: { authorization: `Bearer ${await signUserToken(stranger.id)}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
