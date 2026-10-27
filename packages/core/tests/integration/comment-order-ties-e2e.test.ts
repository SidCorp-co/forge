/**
 * ISS-1421 r38 — two comments written at one instant read back in one order, every time.
 *
 * Postgres stamps `created_at` with the transaction's start, so two writes can share it, and a read
 * ordered by that column alone returns the tie in whatever order the plan meets the rows. The thread
 * a person reads then shows two moves of one landing the wrong way round on one load and right on
 * the next. Every comment read that orders by time breaks the tie on the id.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let ownerId: string;
let projectId: string;
let token: string;
let app: Hono<{ Variables: RequestIdVars }>;
let jwt: typeof import('../../src/auth/jwt.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  jwt = await import('../../src/auth/jwt.js');
  const { commentRoutes, registerIssueCommentRoutes } = await import('../../src/comments/routes.js');
  const { requireAuth } = await import('../../src/middleware/auth.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/comments', commentRoutes);
  const issueRoutes = new Hono<{ Variables: RequestIdVars }>();
  issueRoutes.use('*', requireAuth());
  registerIssueCommentRoutes(issueRoutes as never);
  app.route('/api/issues', issueRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${ownerId}`);
  projectId = (await createTestProject(harness.db, ownerId)).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
  token = await jwt.signUserToken(ownerId);
});

const AT = '2026-10-28T09:00:00.000001Z';

/** A parent and `n` replies all stamped `AT`, each id lower than the one written before it, so
 *  neither insertion order nor id order can pass for the other. */
async function plantTie(n: number): Promise<{ parent: string; byId: string[] }> {
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 1, 'Tie', 'open', ${ownerId})`);
  const parent = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, body, created_at)
    VALUES (${parent}, ${issueId}, ${ownerId}, 'parent', ${AT}::timestamptz - interval '1 second')`);
  const ids = Array.from(
    { length: n },
    (_, at) => `${(15 - at).toString(16).repeat(8)}-0000-4000-8000-000000000000`,
  );
  for (const id of ids) {
    await harness.db.execute(sql`
      INSERT INTO comments (id, issue_id, author_id, body, parent_id, created_at)
      VALUES (${id}, ${issueId}, ${ownerId}, ${`reply ${id.slice(0, 1)}`}, ${parent}, ${AT}::timestamptz)`);
  }
  return { parent, byId: [...ids].sort() };
}

/** A parent and two replies inside one millisecond, the later one holding the lower id, so an order
 *  by the millisecond and then the id reads them the wrong way round (ISS-1421 r39, judge-160). */
async function plantInsideOneMillisecond(): Promise<{ issueId: string; parent: string; order: string[] }> {
  const issueId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 2, 'Inside a millisecond', 'open', ${ownerId})`);
  const parent = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO comments (id, issue_id, author_id, body, created_at)
    VALUES (${parent}, ${issueId}, ${ownerId}, 'parent', '2026-10-28T09:00:00.000000Z'::timestamptz)`);
  const earlier = 'ffffffff-0000-4000-8000-000000000000';
  const later = '00000000-0000-4000-8000-000000000000';
  for (const [id, at] of [
    [earlier, '2026-10-28T09:00:01.000100Z'],
    [later, '2026-10-28T09:00:01.000900Z'],
  ] as const) {
    await harness.db.execute(sql`
      INSERT INTO comments (id, issue_id, author_id, body, parent_id, created_at)
      VALUES (${id}, ${issueId}, ${ownerId}, ${`reply ${id.slice(0, 1)}`}, ${parent}, ${at}::timestamptz)`);
  }
  return { issueId, parent, order: [earlier, later] };
}

describe('comments written inside one millisecond', () => {
  it("are read in the database's order by the issue's thread and by their parent's replies alike", async () => {
    const { issueId, parent, order } = await plantInsideOneMillisecond();
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const thread = await app.request(`/api/issues/${issueId}/comments?limit=50`, auth);
    expect(thread.status).toBe(200);
    const tree = (await thread.json()) as { items: Array<{ id: string; replies: Array<{ id: string }> }> };
    expect(tree.items.map((r) => r.id)).toEqual([parent]);
    expect(tree.items[0]?.replies.map((r) => r.id)).toEqual(order);
    const replies = await app.request(`/api/comments/${parent}/replies?limit=50`, auth);
    expect(replies.status).toBe(200);
    expect(((await replies.json()) as { items: Array<{ id: string }> }).items.map((r) => r.id)).toEqual(order);
  });
});

describe('comments written at one instant', () => {
  it('a thread lists replies sharing a time in id order, on every read', async () => {
    const { parent, byId } = await plantTie(6);
    for (let read = 0; read < 3; read += 1) {
      const res = await app.request(`/api/comments/${parent}/replies?limit=50`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ id: string }> };
      expect(body.items.map((r) => r.id)).toEqual(byId);
    }
  });

  it('a page boundary inside a tie neither repeats nor drops a reply', async () => {
    const { parent, byId } = await plantTie(6);
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const res = await app.request(`/api/comments/${parent}/replies?limit=2&offset=${offset}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { items: Array<{ id: string }> };
      seen.push(...body.items.map((r) => r.id));
    }
    expect(seen).toEqual(byId);
  });
});
