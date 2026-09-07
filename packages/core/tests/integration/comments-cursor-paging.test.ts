/**
 * ISS-956 — `GET /api/issues/:id/comments` walked to the end by cursor.
 *
 * Against real Postgres because the whole claim is about keyset ordering under
 * concurrent writes: a mocked builder cannot produce a millisecond tie, cannot
 * be asked what a row inserted between two reads does to the next page, and
 * the depth-3 trigger that bounds the reply rounds only exists in the DB.
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

type CommentNode = {
  id: string;
  parentId: string | null;
  body: string;
  replies?: CommentNode[];
};

type ThreadPage = {
  items: CommentNode[];
  returned: number;
  total: number;
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
};

type Mods = {
  issueRoutes: typeof import('../../src/issues/routes.js')['issueRoutes'];
  signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];
  errorHandler: typeof import('../../src/middleware/error.js')['errorHandler'];
};

let harness: TestDatabase;
let mods: Mods;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

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

  const [issuesMod, jwtMod, errMod] = await Promise.all([
    import('../../src/issues/routes.js'),
    import('../../src/auth/jwt.js'),
    import('../../src/middleware/error.js'),
  ]);
  mods = {
    issueRoutes: issuesMod.issueRoutes,
    signUserToken: jwtMod.signUserToken,
    errorHandler: errMod.errorHandler,
  };

  app = new Hono();
  app.route('/api/issues', mods.issueRoutes);
  app.onError(mods.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function seed() {
  const owner = await createTestUser(harness.db, { email: 'owner@test.local' });
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${owner.id}`);
  const project = await createTestProject(harness.db, owner.id);
  await createTestProjectMember(harness.db, {
    userId: owner.id,
    projectId: project.id,
    role: 'admin',
  });
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id)
    VALUES (${project.id}, 'paging-target', ${owner.id})
    RETURNING id
  `);
  const issueId = (rows[0] as { id: string }).id;
  const jwt = await mods.signUserToken(owner.id);
  return { owner, project, issueId, jwt };
}

async function addComment(
  issueId: string,
  authorId: string,
  body: string,
  parentId: string | null = null,
) {
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO comments (issue_id, author_id, body, parent_id)
    VALUES (${issueId}, ${authorId}, ${body}, ${parentId})
    RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

async function readPage(issueId: string, jwt: string, query = ''): Promise<ThreadPage> {
  const res = await app.request(`/api/issues/${issueId}/comments${query}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ThreadPage;
}

function flatten(nodes: CommentNode[]): CommentNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.replies ?? [])]);
}

describe('ISS-956 comment thread paging — the envelope and the walk', () => {
  it('answers the cursor envelope and nothing else (AC 1)', async () => {
    const { owner, issueId, jwt } = await seed();
    await addComment(issueId, owner.id, 'only');

    const page = await readPage(issueId, jwt);

    expect(Object.keys(page).sort()).toEqual(
      ['hasMore', 'items', 'limit', 'nextCursor', 'returned', 'total'].sort(),
    );
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    expect(page.hasMore).toBe(false);
  });

  // cm:guard the field set on a comment NODE is what the issue-detail screen renders, and ISS-956 moved this route off its own private projection onto the service's. Pin the keys: an extra one (the cursor key that mints the token is selected on the same query) leaks the paging machinery into the screen's data, and a missing one blanks an author line with nothing failing.
  it('renders a comment with the same fields as before the cursor (AC 14)', async () => {
    const { owner, issueId, jwt } = await seed();
    const rootId = await addComment(issueId, owner.id, 'root');
    await addComment(issueId, owner.id, 'reply', rootId);

    const page = await readPage(issueId, jwt);
    const node = page.items[0] as unknown as Record<string, unknown>;

    expect(Object.keys(node).sort()).toEqual(
      [
        'attachments',
        'author',
        'authorDeviceId',
        'authorId',
        'body',
        'createdAt',
        'format',
        'id',
        'issueId',
        'nodes',
        'parentId',
        'replies',
        'template',
        'updatedAt',
      ].sort(),
    );
    expect(node.author).not.toBeNull();
    expect(node.replies as unknown[]).toHaveLength(1);
  });

  it('offers a cursor when more roots remain, and resumes from it (AC 2, 3, 6)', async () => {
    const { owner, issueId, jwt } = await seed();
    for (let i = 0; i < 5; i += 1) await addComment(issueId, owner.id, `c${i}`);

    const first = await readPage(issueId, jwt, '?limit=2');
    expect(first.items.map((n) => n.body)).toEqual(['c0', 'c1']);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.hasMore).toBe(true);

    const second = await readPage(
      issueId,
      jwt,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    expect(second.items.map((n) => n.body)).toEqual(['c2', 'c3']);

    const third = await readPage(
      issueId,
      jwt,
      `?limit=2&cursor=${encodeURIComponent(second.nextCursor as string)}`,
    );
    expect(third.items.map((n) => n.body)).toEqual(['c4']);
    expect(third.nextCursor).toBeNull();
    expect(third.hasMore).toBe(false);
  });

  it('yields all forty comments exactly once when walked to exhaustion (AC 4)', async () => {
    const { owner, issueId, jwt } = await seed();
    for (let i = 0; i < 40; i += 1) await addComment(issueId, owner.id, `c${i}`);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let round = 0; round < 20; round += 1) {
      const q = cursor === null ? '?limit=7' : `?limit=7&cursor=${encodeURIComponent(cursor)}`;
      const page: ThreadPage = await readPage(issueId, jwt, q);
      seen.push(...flatten(page.items).map((n) => n.body));
      expect(page.total).toBe(40);
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(cursor).toBeNull();
    expect(seen).toHaveLength(40);
    // cm:guard assert the SET, not the sequence. `created_at` defaults to `now()` and two of forty inserts land in the same microsecond often enough to flake; the walk then orders those two by id, which is deterministic and correct but is not insertion order. A sequence assertion here fails for a reason that is not the paging.
    expect(new Set(seen)).toEqual(new Set(Array.from({ length: 40 }, (_, i) => `c${i}`)));
  });

  it('nests every reply under its own root, on that root page (AC 5)', async () => {
    const { owner, issueId, jwt } = await seed();
    const rootIds: string[] = [];
    for (let i = 0; i < 4; i += 1) rootIds.push(await addComment(issueId, owner.id, `c${i}`));
    await addComment(issueId, owner.id, 'r-on-c0', rootIds[0] as string);
    await addComment(issueId, owner.id, 'r-on-c3', rootIds[3] as string);

    const first = await readPage(issueId, jwt, '?limit=2');
    expect(first.items.map((n) => n.body)).toEqual(['c0', 'c1']);
    expect(first.items[0]?.replies?.map((r) => r.body)).toEqual(['r-on-c0']);
    expect(first.items[1]?.replies ?? []).toEqual([]);
    // cm:guard the off-page reply must be ABSENT, not promoted — `buildCommentTree` drops a reply whose parent it was not given, and that guard is the whole reason the cursor walks roots rather than comments. Assert absence, because a promoted reply reads as an extra root and the walk then returns it twice (ISS-956).
    expect(flatten(first.items).map((n) => n.body)).not.toContain('r-on-c3');

    const second = await readPage(
      issueId,
      jwt,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    expect(second.items[1]?.replies?.map((r) => r.body)).toEqual(['r-on-c3']);
  });
});

describe('ISS-956 comment thread paging — writes, caps and refusals', () => {
  it('never returns a comment twice when one is written between two reads (AC 7)', async () => {
    const { owner, issueId, jwt } = await seed();
    for (let i = 0; i < 4; i += 1) await addComment(issueId, owner.id, `c${i}`);

    const first = await readPage(issueId, jwt, '?limit=2');
    await addComment(issueId, owner.id, 'written-between');

    const seen = [...first.items.map((n) => n.body)];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page: ThreadPage = await readPage(
        issueId,
        jwt,
        `?limit=2&cursor=${encodeURIComponent(cursor)}`,
      );
      seen.push(...page.items.map((n) => n.body));
      cursor = page.nextCursor;
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((b) => b === 'c0')).toHaveLength(1);
    expect(seen).toContain('written-between');
  });

  it('walks past roots that share a createdAt millisecond', async () => {
    const { owner, issueId, jwt } = await seed();
    await harness.db.execute(sql`
      INSERT INTO comments (issue_id, author_id, body, created_at)
      SELECT ${issueId}, ${owner.id}, 't' || g, '2026-09-06T18:58:11.000Z'::timestamptz
      FROM generate_series(0, 5) AS g
    `);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let round = 0; round < 10; round += 1) {
      const q = cursor === null ? '?limit=2' : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const page: ThreadPage = await readPage(issueId, jwt, q);
      seen.push(...page.items.map((n) => n.body));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(6);
  });

  it('reads a thread past every cap the route used to carry (AC 13)', async () => {
    const { owner, issueId, jwt } = await seed();
    await harness.db.execute(sql`
      INSERT INTO comments (issue_id, author_id, body)
      SELECT ${issueId}, ${owner.id}, 'c' || lpad(g::text, 4, '0')
      FROM generate_series(1, 1200) AS g
    `);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let round = 0; round < 12; round += 1) {
      const q = cursor === null ? '?limit=200' : `?limit=200&cursor=${encodeURIComponent(cursor)}`;
      const page: ThreadPage = await readPage(issueId, jwt, q);
      seen.push(...page.items.map((n) => n.body));
      expect(page.total).toBe(1200);
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(1200);
  }, 60_000);

  it('refuses a cursor it did not mint with 400 BAD_REQUEST (AC 8)', async () => {
    const { owner, issueId, jwt } = await seed();
    await addComment(issueId, owner.id, 'c0');

    const res = await app.request(`/api/issues/${issueId}/comments?cursor=50`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; cause?: { code?: string } };
    expect(body.code ?? body.cause?.code).toBe('BAD_REQUEST');
  });

  it('accepts ?offset and changes nothing about which rows come back (AC 9)', async () => {
    const { owner, issueId, jwt } = await seed();
    for (let i = 0; i < 4; i += 1) await addComment(issueId, owner.id, `c${i}`);

    const plain = await readPage(issueId, jwt, '?limit=2');
    const offset = await readPage(issueId, jwt, '?limit=2&offset=2');

    expect(offset.items.map((n) => n.body)).toEqual(plain.items.map((n) => n.body));
    expect(offset.nextCursor).toBe(plain.nextCursor);
  });
});
