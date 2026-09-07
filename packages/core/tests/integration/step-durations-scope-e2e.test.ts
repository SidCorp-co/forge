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

  const [analytics, metrics, jwt, err] = await Promise.all([
    import('../../src/pipeline/analytics-routes.js'),
    import('../../src/metrics/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  signUserToken = jwt.signUserToken;
  app = new Hono();
  app.route('/api/pipeline', analytics.pipelineAnalyticsRoutes);
  app.route('/api/projects', metrics.projectMetricsRoutes);
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

// cm:guard this is the PAT-reachable half, and the pair is the point: `/api/pipeline/step-durations` fans out and must stay off the PAT allowlist, so a token-holding caller reaches durations ONLY here. Delete this route and `forge_metrics.step_durations`'s deletion becomes a capability loss rather than a move — which is what it briefly was, live, until 2026-09-01.
describe('GET /api/projects/:id/metrics/step-durations', () => {
  it('serves the caller own project and refuses one they are not a member of', async () => {
    const mine = await seedProjectWithOneStep('code');
    const theirs = await seedProjectWithOneStep('review');

    const ok = await app.request(
      `/api/projects/${mine.project.id}/metrics/step-durations?days=30`,
      { headers: { authorization: `Bearer ${mine.token}` } },
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { rows: Array<{ step: string }>; windowDays: number };
    expect(body.rows.map((r) => r.step)).toEqual(['code']);
    expect(body.windowDays).toBe(30);

    const denied = await app.request(
      `/api/projects/${theirs.project.id}/metrics/step-durations?days=30`,
      { headers: { authorization: `Bearer ${mine.token}` } },
    );
    expect(denied.status).toBe(403);
  });
});

// cm:guard both of these had ONLY a `/api/pipeline/*` fan-out route, which is off the PAT allowlist — so retiring their tools without this project-scoped half would leave a token-holding caller with no path at all, which is exactly what briefly happened to step-durations live on 2026-09-01. Assert the member/non-member pair, not just a 200: the fan-out is fenced by prefix, but THIS half is fenced only by the role check below it.
describe('project-scoped metrics a token can reach', () => {
  it.each([['retry-rescues'], ['session-failures']])(
    'serves %s to a member and refuses a stranger',
    async (leaf) => {
      const mine = await seedProjectWithOneStep('code');
      const stranger = await createTestUser(harness.db);
      await harness.db.execute(
        sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
      );

      const ok = await app.request(`/api/projects/${mine.project.id}/metrics/${leaf}?days=30`, {
        headers: { authorization: `Bearer ${mine.token}` },
      });
      expect(ok.status).toBe(200);
      expect((await ok.json()) as { projectId: string }).toMatchObject({
        projectId: mine.project.id,
        windowDays: 30,
      });

      const denied = await app.request(`/api/projects/${mine.project.id}/metrics/${leaf}?days=30`, {
        headers: { authorization: `Bearer ${await signUserToken(stranger.id)}` },
      });
      expect(denied.status).toBe(403);
    },
  );
});

// cm:guard the interventions half, and it is asserted against the REAL view rather than a shape: `issue_intervention_events` unions four sources and the rollup buckets on the `manual_` PREFIX, so a seed of one wedge and one `manual_inject` is what distinguishes a working bucket from a route that merely answers. The stranger's row is the fence — the failure being guarded is one project's north-star number carrying another project's flips (ISS-944).
describe('GET /api/projects/:id/metrics/interventions', () => {
  async function seedInterventions(owner: { id: string }, projectId: string) {
    const issueId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${issueId}, ${projectId}, 2, 'intervention fixture', 'open', ${owner.id})`);
    await harness.db.execute(sql`
      INSERT INTO notifications (id, user_id, project_id, issue_id, type, title)
      VALUES (${randomUUID()}, ${owner.id}, ${projectId}, ${issueId}, 'pipeline_wedge',
              'run wedged')`);
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${issueId}, 'issue', 'completed', now())`);
    const jobId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, payload,
                        created_by, queued_at)
      VALUES (${jobId}, ${projectId}, ${issueId}, ${runId}, 'code', 'done', '{}'::jsonb,
              ${owner.id}, now())`);
    await harness.db.execute(sql`
      INSERT INTO job_events (id, job_id, seq, kind, data, ts)
      VALUES (${randomUUID()}, ${jobId}, 1, 'intervention',
              '{"action":"inject","reason":"a person reached in"}'::jsonb, now())`);
    return issueId;
  }

  it('serves a member the rollup, bucketed, and never another project rows', async () => {
    const mine = await seedProjectWithOneStep('code');
    const theirs = await seedProjectWithOneStep('review');
    const myIssue = await seedInterventions(mine.owner, mine.project.id);
    await seedInterventions(theirs.owner, theirs.project.id);

    const res = await app.request(
      `/api/projects/${mine.project.id}/metrics/interventions?days=30`,
      { headers: { authorization: `Bearer ${mine.token}` } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      byIssue: Array<{
        issueId: string;
        projectId: string;
        wedges: number;
        manualJobActions: number;
        total: number;
      }>;
      events: Array<{ source: string; projectId: string }>;
    };
    expect(body.total).toBe(2);
    expect(body.byIssue).toHaveLength(1);
    expect(body.byIssue[0]).toMatchObject({
      issueId: myIssue,
      projectId: mine.project.id,
      wedges: 1,
      manualJobActions: 1,
      total: 2,
    });
    expect(body.events.map((e) => e.source).sort()).toEqual(['manual_inject', 'wedge']);
    expect(body.events.every((e) => e.projectId === mine.project.id)).toBe(true);
  });

  it('refuses a caller who is not a member', async () => {
    const mine = await seedProjectWithOneStep('code');
    await seedInterventions(mine.owner, mine.project.id);
    const stranger = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
    );

    const res = await app.request(
      `/api/projects/${mine.project.id}/metrics/interventions?days=30`,
      { headers: { authorization: `Bearer ${await signUserToken(stranger.id)}` } },
    );
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('manual_inject');
  });
});
