/**
 * The project Needs you tile lists a person's attention items from two responses, each of which
 * cuts its list: `/api/me/attention` (questions and parked issues at 20 across every project the
 * viewer owns, failed jobs and reviews at 5) and `/api/projects/health` (parked issues at 5 per
 * project). Each carries the unclipped count beside its list, so the tile can say how much of the
 * whole it shows (ISS-1156).
 *
 * Every assertion goes through `app.request` as a signed-in viewer, with the seed judge j3 found the
 * silence on: a project holding 1 issue with an open question and 9 at needs_info.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let viewer: string;
let projectId: string;
let slug: string;
let seq = 0;

beforeEach(async () => {
  await truncateAll(harness.db);
  seq = 0;
  viewer = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${viewer}`);
  const project = await createTestProject(harness.db, viewer);
  projectId = project.id;
  slug = project.slug;
  await createTestProjectMember(harness.db, { userId: viewer, projectId, role: 'admin' });
});

async function issueAt(
  status: string,
  withQuestion: boolean,
  owner: string = viewer,
): Promise<string> {
  seq += 1;
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, assignee_id,
                        created_at, updated_at)
    VALUES (${id}, ${projectId}, ${seq}, ${`ISS-${seq} at ${status}`}, ${status}, ${owner},
            ${owner}, now(), now())
  `);
  if (withQuestion) {
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, status, blocker_kind, steps,
                                   claims_held, workspaces_pinned, dependents)
      VALUES (${randomUUID()}, ${projectId}, ${id}, 'open', 'human', '[]'::jsonb, 0, 0, 0)
    `);
  }
  return id;
}

/** A stuck-issue notice standing for the issue, as the waiting-park sweep raises one at six hours. */
async function noticeFor(issueId: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO notifications (project_id, issue_id, type, kind, tier, state, title, resolution_key)
    VALUES (${projectId}, ${issueId}, 'issue_stranded', 'condition', 'ticket', 'firing',
            'parked', ${`issue:${issueId}:stranded`})
  `);
}

async function get<T>(path: string): Promise<T> {
  const res = await app.request(path, {
    headers: { authorization: `Bearer ${await signUserToken(viewer)}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

describe('the counts beside the lists the Needs you tile is read from', () => {
  it('counts the 10 issues a person has to act on where the lists name fewer', async () => {
    await issueAt('in_progress', true);
    for (let i = 0; i < 9; i++) await issueAt('needs_info', false);

    const attention = await get<{
      awaitingInput: unknown[];
      projectTotals: Record<string, { awaitingInput: number }>;
    }>('/api/me/attention');
    const health =
      await get<Array<{ projectSlug: string; blockers: unknown[]; blockersTotal: number }>>(
        '/api/projects/health',
      );

    expect(attention.projectTotals[slug]?.awaitingInput).toBe(10);
    const row = health.find((h) => h.projectSlug === slug);
    expect(row?.blockers).toHaveLength(5);
    expect(row?.blockersTotal).toBe(9);
  });

  it('states a project with nothing to act on as no entry, and a parked count of zero', async () => {
    await issueAt('in_progress', false);
    const attention = await get<{ projectTotals: Record<string, unknown> }>('/api/me/attention');
    const health =
      await get<Array<{ projectSlug: string; blockersTotal: number }>>('/api/projects/health');
    expect(attention.projectTotals).toEqual({});
    expect(health.find((h) => h.projectSlug === slug)?.blockersTotal).toBe(0);
  });

  it('lets the two responses add up to what is owed without counting an issue in both', async () => {
    // j4's shape: the viewer's own waiting issue is in the attention response only, other people's
    // on_hold and needs_info issues are in the health row only, and a needs_info issue the viewer
    // owns with a question is in both. Of the other people's parks, only the one a stuck-issue notice
    // stands for is the viewer's to act on (ISS-1229 r17, judge-44).
    const other = (await createTestUser(harness.db)).id;
    await createTestProjectMember(harness.db, { userId: other, projectId, role: 'member' });
    await issueAt('waiting', false);
    await issueAt('on_hold', false, other);
    await noticeFor(await issueAt('needs_info', false, other));
    await issueAt('needs_info', true);

    const attention = await get<{
      projectTotals: Record<string, { awaitingInput: number; parkedOnly: number }>;
    }>('/api/me/attention');
    const health =
      await get<Array<{ projectSlug: string; blockersTotal: number }>>('/api/projects/health');

    const totals = attention.projectTotals[slug];
    expect(totals?.awaitingInput).toBe(2);
    expect(totals?.parkedOnly).toBe(1);
    const blockersTotal = health.find((h) => h.projectSlug === slug)?.blockersTotal ?? 0;
    expect(blockersTotal).toBe(4);
    // three distinct issues are the viewer's to act on: their own two, and the park by someone else
    // a notice stands for; the fourth waits on its owner alone.
    expect((totals?.awaitingInput ?? 0) + (totals?.parkedOnly ?? 0)).toBe(3);
  });

  it("counts a waiting issue somebody else owns only once a stuck-issue notice stands for it", async () => {
    // j15's scratch reading: the headline counted it as blocked on a person and no list named it;
    // judge-44: before any notice it is its owner's alone, not the viewer's to act on (ISS-1229 r17).
    const other = (await createTestUser(harness.db)).id;
    await createTestProjectMember(harness.db, { userId: other, projectId, role: 'member' });
    const parked = await issueAt('waiting', false, other);
    const before = await get<{ projectTotals: Record<string, { parkedOnly: number }> }>(
      '/api/me/attention',
    );
    expect(before.projectTotals[slug]?.parkedOnly ?? 0).toBe(0);
    await noticeFor(parked);

    const attention = await get<{ projectTotals: Record<string, unknown> }>('/api/me/attention');
    const health =
      await get<
        Array<{ projectSlug: string; blockers: Array<{ status: string }>; blockersTotal: number }>
      >('/api/projects/health');

    expect(attention.projectTotals[slug]).toEqual({
      needsReview: 0,
      awaitingInput: 0,
      awaitingAsked: 0,
      failedJobs: 0,
      parkedOnly: 1,
      parkedAsked: 0,
      stuckOnly: 0,
    });
    const row = health.find((h) => h.projectSlug === slug);
    expect({ listed: row?.blockers.map((b) => b.status), total: row?.blockersTotal }).toEqual({
      listed: ['waiting'],
      total: 1,
    });
  });
});
