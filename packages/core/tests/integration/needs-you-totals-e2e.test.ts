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
): Promise<void> {
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
    // owns with a question is in both.
    const other = (await createTestUser(harness.db)).id;
    await createTestProjectMember(harness.db, { userId: other, projectId, role: 'member' });
    await issueAt('waiting', false);
    await issueAt('on_hold', false, other);
    await issueAt('needs_info', false, other);
    await issueAt('needs_info', true);

    const attention = await get<{
      projectTotals: Record<string, { awaitingInput: number; awaitingOutsideBlockers: number }>;
    }>('/api/me/attention');
    const health =
      await get<Array<{ projectSlug: string; blockersTotal: number }>>('/api/projects/health');

    const totals = attention.projectTotals[slug];
    expect(totals?.awaitingInput).toBe(2);
    expect(totals?.awaitingOutsideBlockers).toBe(1);
    const blockersTotal = health.find((h) => h.projectSlug === slug)?.blockersTotal ?? 0;
    expect(blockersTotal).toBe(3);
    // four distinct issues are owed to this viewer or parked; the two sources sum to four.
    expect((totals?.awaitingOutsideBlockers ?? 0) + blockersTotal).toBe(4);
  });
});
