/**
 * ISS-1113 — the record store over REST, which is the destination the refusal
 * on a comment fence names.
 *
 * Against real Postgres because the claim is about rows: which column a typed
 * value lands in, and that `source_comment_id` really holds the comment the
 * assertion came from. The pointer back is a foreign key, and a mocked handle
 * cannot be wrong about a foreign key it never wrote.
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
  signUserToken = jwtMod.signUserToken;
  app = new Hono();
  app.route('/api/issues', issuesMod.issueRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

/**
 * `issue_attribute_defs` is reference data seeded by migration 0245, and
 * `truncateAll` empties it with everything else — so every test here restores
 * it from the same registry the write validates against. Without it the FK
 * fails and the route answers the drift refusal instead, which is its own test
 * below.
 */
async function seedDefs(): Promise<void> {
  const { ATTRIBUTE_REGISTRY } = await import('../../src/issues/attributes/registry.js');
  for (const def of ATTRIBUTE_REGISTRY) {
    await harness.db.execute(sql`
      INSERT INTO issue_attribute_defs (key, label, value_type, cardinality, written_by, surfaces, required)
      VALUES (${def.key}, ${def.label}, ${def.valueType}, ${def.cardinality}, ${def.writtenBy},
              ${JSON.stringify(def.surfaces)}::jsonb, ${def.required})
      ON CONFLICT (key) DO NOTHING
    `);
  }
}

beforeEach(async () => {
  await truncateAll(harness.db);
  await seedDefs();
});

type Rendered = {
  key: string;
  value: unknown;
  sourceCommentId: string | null;
};
type WriteResult = { written: number; attributes: Rendered[] };
type ReadResult = { attributes: Rendered[] };

async function seed() {
  const owner = await createTestUser(harness.db, { email: 'owner@test.local' });
  const reader = await createTestUser(harness.db, { email: 'reader@test.local' });
  for (const u of [owner, reader]) {
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${u.id}`);
  }
  const project = await createTestProject(harness.db, owner.id);
  await createTestProjectMember(harness.db, {
    userId: owner.id,
    projectId: project.id,
    role: 'admin',
  });
  await createTestProjectMember(harness.db, {
    userId: reader.id,
    projectId: project.id,
    role: 'viewer',
  });
  const issueRows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id)
    VALUES (${project.id}, 'the subject', ${owner.id})
    RETURNING id
  `);
  const otherRows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id)
    VALUES (${project.id}, 'the issue it supersedes', ${owner.id})
    RETURNING id
  `);
  const issueId = (issueRows[0] as { id: string }).id;
  const commentRows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO comments (issue_id, author_id, body)
    VALUES (${issueId}, ${owner.id}, 'This one supersedes the other; here is why in a sentence.')
    RETURNING id
  `);
  return {
    issueId,
    otherIssueId: (otherRows[0] as { id: string }).id,
    commentId: (commentRows[0] as { id: string }).id,
    jwt: await signUserToken(owner.id),
    readerJwt: await signUserToken(reader.id),
  };
}

const write = (issueId: string, jwt: string, attributes: unknown[]) =>
  app.request(`/api/issues/${issueId}/attributes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ attributes }),
  });

const read = (issueId: string, jwt: string) =>
  app.request(`/api/issues/${issueId}/attributes`, {
    headers: { authorization: `Bearer ${jwt}` },
  });

describe('POST /api/issues/:id/attributes', () => {
  it('writes one typed row and answers with the issue records', async () => {
    const { issueId, otherIssueId, jwt } = await seed();
    const res = await write(issueId, jwt, [{ key: 'supersedes', value: otherIssueId }]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as WriteResult;
    expect(body.written).toBe(1);
    expect(body.attributes.map((a) => a.key)).toEqual(['supersedes']);
  });

  it('lands a typed value in the column its key declares', async () => {
    const { issueId, jwt } = await seed();
    await write(issueId, jwt, [{ key: 'human_required', value: true }]);
    const rows = await harness.db.execute<{ value_bool: boolean; value_text: string | null }>(
      sql`SELECT value_bool, value_text FROM issue_attributes WHERE issue_id = ${issueId}`,
    );
    expect(rows[0]).toMatchObject({ value_bool: true, value_text: null });
  });

  it('keeps the pointer back to the comment that asserted it', async () => {
    const { issueId, otherIssueId, commentId, jwt } = await seed();
    await write(issueId, jwt, [
      { key: 'supersedes', value: otherIssueId, sourceCommentId: commentId },
    ]);
    const rows = await harness.db.execute<{ source_comment_id: string }>(
      sql`SELECT source_comment_id FROM issue_attributes WHERE issue_id = ${issueId}`,
    );
    expect((rows[0] as { source_comment_id: string }).source_comment_id).toBe(commentId);
  });

  it('refuses an unregistered key by name and lists the keys it holds', async () => {
    const { issueId, jwt } = await seed();
    const res = await write(issueId, jwt, [{ key: 'not_a_key', value: 'x' }]);
    expect(res.status).toBe(400);
    const refused = (await res.json()) as { code: string; message: string };
    expect(refused.code).toBe('UNREGISTERED_KEY');
    expect(refused.message).toContain('not_a_key');
    expect(refused.message).toContain('supersedes');
  });

  it('refuses a value of the wrong declared type by name', async () => {
    const { issueId, jwt } = await seed();
    const res = await write(issueId, jwt, [{ key: 'human_required', value: 'yes please' }]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('WRONG_TYPE');
  });

  it('refuses a caller holding less than writer on the project', async () => {
    const { issueId, otherIssueId, readerJwt } = await seed();
    const res = await write(issueId, readerJwt, [{ key: 'supersedes', value: otherIssueId }]);
    expect(res.status).toBe(403);
  });

  it('names the drift when the code registry and the seed disagree', async () => {
    const { issueId, jwt } = await seed();
    await harness.db.execute(sql`DELETE FROM issue_attribute_defs WHERE key = 'human_required'`);
    const res = await write(issueId, jwt, [{ key: 'human_required', value: true }]);
    expect(res.status).toBe(409);
    const refused = (await res.json()) as { code: string; message: string };
    expect(refused.code).toBe('ATTRIBUTE_DEF_MISSING');
    expect(refused.message).toContain('human_required');
    expect(refused.message).toContain('drifted');
  });

  it('keeps the value a batch that fails mid-write would otherwise have deleted', async () => {
    const { issueId, otherIssueId, jwt } = await seed();
    await write(issueId, jwt, [{ key: 'human_required', value: true }]);
    // `supersedes` still validates in code, so the batch reaches the delete of
    // the cardinality-one row and then fails on the defs FK on the insert.
    await harness.db.execute(sql`DELETE FROM issue_attribute_defs WHERE key = 'supersedes'`);
    const res = await write(issueId, jwt, [
      { key: 'human_required', value: false },
      { key: 'supersedes', value: otherIssueId },
    ]);
    expect(res.status).toBe(409);
    const rows = await harness.db.execute<{ value_bool: boolean }>(
      sql`SELECT value_bool FROM issue_attributes WHERE issue_id = ${issueId} AND key = 'human_required'`,
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { value_bool: boolean }).value_bool).toBe(true);
  });

  it('answers 404 for an issue that is not there', async () => {
    const { jwt } = await seed();
    const res = await write('00000000-0000-4000-8000-000000000000', jwt, [
      { key: 'human_required', value: true },
    ]);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/issues/:id/attributes', () => {
  it('answers with the issue records, each carrying its source comment', async () => {
    const { issueId, otherIssueId, commentId, jwt } = await seed();
    await write(issueId, jwt, [
      { key: 'supersedes', value: otherIssueId, sourceCommentId: commentId },
    ]);
    const res = await read(issueId, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadResult;
    expect(body.attributes).toHaveLength(1);
    expect(body.attributes[0]?.sourceCommentId).toBe(commentId);
  });

  it('lets a viewer read what it may not write', async () => {
    const { issueId, readerJwt } = await seed();
    expect((await read(issueId, readerJwt)).status).toBe(200);
  });
});
