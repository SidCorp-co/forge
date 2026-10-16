/**
 * ISS-1229 r10 — `PATCH /issues/batch` writes an issue's priority and category inside its status
 * move's own transaction, so a refused move leaves that issue exactly as it was. The refusal is
 * that issue's skip reason, and its detail says nothing else was written. Real Postgres; each case
 * reads the row back.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.NODE_ENV ??= 'test';

  const [extrasMod, jwtMod, errMod] = await Promise.all([
    import('../../src/issues/extras-routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  signUserToken = jwtMod.signUserToken;
  app = new Hono();
  app.route('/api/issues', extrasMod.issueExtrasRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

type World = { userId: string; projectId: string; token: string };

async function seed(): Promise<World> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  return { userId: user.id, projectId: project.id, token: await signUserToken(user.id) };
}

async function insertIssue(w: World, status: string): Promise<string> {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id, status, priority, category)
    VALUES (${w.projectId}::uuid, 'the subject', ${w.userId}::uuid, ${status}, 'low', 'chore')
    RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

async function whole(id: string) {
  const rows = await harness.db.execute(sql`
    SELECT status, priority, category, updated_at::text AS updated_at
      FROM issues WHERE id = ${id}::uuid
  `);
  return rows[0];
}

type Answer = {
  updated: Array<{ id: string }>;
  skipped: Array<{ id: string; reason: string; detail?: string }>;
  failed: Array<{ id: string; error: string }>;
};

async function batch(w: World, ids: string[], data: Record<string, unknown>): Promise<Answer> {
  const res = await app.request('/api/issues/batch', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${w.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ids, data }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Answer;
}

const FIELDS = { priority: 'critical', category: 'bug' };

describe('PATCH /issues/batch — an issue whose status move is refused keeps every field', () => {
  it.each([
    ['an unchanged status', 'confirmed', 'confirmed', 'no_op'],
    ['an illegal move out of Draft', 'draft', 'testing', 'illegal_transition'],
    ['a close with nothing shipped', 'testing', 'closed', 'close_requires_shipped'],
  ])(
    'a refused move (%s) writes neither priority nor category',
    async (_what, from, to, reason) => {
      const w = await seed();
      const id = await insertIssue(w, from);
      const before = await whole(id);

      const answer = await batch(w, [id], { status: to, ...FIELDS });

      expect(answer.updated).toEqual([]);
      expect(answer.failed).toEqual([]);
      expect(answer.skipped).toEqual([
        {
          id,
          reason,
          detail: expect.stringContaining('nothing else this update carried was written'),
        },
      ]);
      expect(await whole(id)).toEqual(before);
    },
  );

  it('skips only the refused issue, and writes the one whose move is made', async () => {
    const w = await seed();
    const refused = await insertIssue(w, 'draft');
    const moved = await insertIssue(w, 'open');
    const before = await whole(refused);

    const answer = await batch(w, [refused, moved], { status: 'confirmed', ...FIELDS });

    expect(answer.updated.map((u) => u.id)).toEqual([moved]);
    expect(answer.skipped.map((s) => [s.id, s.reason])).toEqual([[refused, 'illegal_transition']]);
    expect(await whole(refused)).toEqual(before);
    expect(await whole(moved)).toMatchObject({ status: 'confirmed', ...FIELDS });
  });

  it('names a refused status alone with no detail, since nothing else was carried', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'confirmed');

    const answer = await batch(w, [id], { status: 'confirmed', priority: 'low' });

    expect(answer.skipped).toEqual([{ id, reason: 'no_op' }]);
  });

  it('still writes the fields of a batch that sends no status', async () => {
    const w = await seed();
    const id = await insertIssue(w, 'confirmed');

    const answer = await batch(w, [id], FIELDS);

    expect(answer.updated.map((u) => u.id)).toEqual([id]);
    expect(await whole(id)).toMatchObject({ status: 'confirmed', ...FIELDS });
  });
});
