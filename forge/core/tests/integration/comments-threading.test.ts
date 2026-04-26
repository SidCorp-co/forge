import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDatabase,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// Integration coverage for ISS-273 PR-A — comment threading.
// Verifies the depth-3 trigger and the parent_id self-FK end-to-end against
// real Postgres. Route-level tests exercise the in-memory tree assembler in
// `src/comments/routes.test.ts`.

describe('comments threading', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    await createTestProjectMember(harness.db, {
      userId: owner.id,
      projectId: project.id,
      role: 'owner',
    });
    const issueRows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO issues (project_id, title, created_by_id)
      VALUES (${project.id}, 'thread-target', ${owner.id})
      RETURNING id
    `);
    const issueId = (issueRows[0] as { id: string }).id;
    return { owner, project, issueId };
  }

  async function insertComment(issueId: string, authorId: string, parentId: string | null) {
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO comments (issue_id, author_id, body, parent_id)
      VALUES (${issueId}, ${authorId}, 'x', ${parentId})
      RETURNING id
    `);
    return (rows[0] as { id: string }).id;
  }

  it('allows a top-level comment (depth 1) and a reply (depth 2)', async () => {
    const { owner, issueId } = await seed();
    const root = await insertComment(issueId, owner.id, null);
    const reply = await insertComment(issueId, owner.id, root);
    expect(root).toBeDefined();
    expect(reply).toBeDefined();
  });

  it('allows depth 3', async () => {
    const { owner, issueId } = await seed();
    const a = await insertComment(issueId, owner.id, null);
    const a1 = await insertComment(issueId, owner.id, a);
    const a1a = await insertComment(issueId, owner.id, a1);
    expect(a1a).toBeDefined();
  });

  it('rejects depth 4 with check_violation (SQLSTATE 23514)', async () => {
    const { owner, issueId } = await seed();
    const a = await insertComment(issueId, owner.id, null);
    const a1 = await insertComment(issueId, owner.id, a);
    const a1a = await insertComment(issueId, owner.id, a1);

    let caught: unknown;
    try {
      await insertComment(issueId, owner.id, a1a);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const code =
      (caught as { code?: string } | undefined)?.code ??
      (caught as { cause?: { code?: string } } | undefined)?.cause?.code;
    expect(code).toBe('23514');
  });

  it('cascades reply deletion when a parent comment is deleted', async () => {
    const { owner, issueId } = await seed();
    const root = await insertComment(issueId, owner.id, null);
    await insertComment(issueId, owner.id, root);
    await insertComment(issueId, owner.id, root);

    await harness.db.execute(sql`DELETE FROM comments WHERE id = ${root}`);

    const remaining = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM comments WHERE issue_id = ${issueId}`,
    );
    expect((remaining[0] as { count: string }).count).toBe('0');
  });
});
