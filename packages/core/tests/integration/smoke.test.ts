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

// End-to-end smoke test for the Phase 2.1-I testing infrastructure.
//
// Verifies that the mode-aware `setupTestDatabase()` helper can:
//   1. Boot a real Postgres (container or disposable schema),
//   2. Run the (currently empty) migrations without error,
//   3. Accept `truncateAll()` calls safely even with zero tables,
//   4. Surface a clear error from factories while the schema is still stubbed.
//
// Downstream issues (Phase 2.1-A/B/C) will add `users` / `projects` tables;
// this test should keep passing once they do, as both code paths are covered.

describe('integration smoke', () => {
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

  it('connects to the test database and executes SELECT 1', async () => {
    const rows = await harness.db.execute<{ one: number }>(sql`SELECT 1 AS one`);
    const first = rows[0] as { one?: unknown } | undefined;
    expect(first?.one).toBe(1);
  });

  it('uses a dedicated schema / database (no cross-run leakage)', async () => {
    const rows = await harness.db.execute<{ schema: string }>(
      sql`SELECT current_schema() AS schema`,
    );
    const schema = (rows[0] as { schema?: unknown } | undefined)?.schema;
    expect(typeof schema).toBe('string');
    expect(schema).not.toBe('information_schema');
  });

  it('truncateAll() is a no-op when no base tables exist', async () => {
    // Should not throw even though the schema is empty (Phase 2.1-A/B pending).
    await truncateAll(harness.db);
  });

  it('factories insert into the real users table', async () => {
    const user = await createTestUser(harness.db);
    const rows = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM users WHERE id = ${user.id}`,
    );
    expect((rows[0] as { count?: string } | undefined)?.count).toBe('1');
  });

  it('ISS-* generator: parallel inserts produce contiguous, unique iss_seq per project', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    await createTestProjectMember(harness.db, {
      userId: owner.id,
      projectId: project.id,
      role: 'admin',
    });

    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        harness.db.execute(sql`
          INSERT INTO issues (project_id, title, created_by_id)
          VALUES (${project.id}, ${`Issue ${i}`}, ${owner.id})
        `),
      ),
    );

    const rows = await harness.db.execute<{ iss_seq: number }>(sql`
      SELECT iss_seq FROM issues WHERE project_id = ${project.id} ORDER BY iss_seq
    `);
    const seqs = rows.map((r) => Number((r as { iss_seq: number }).iss_seq));
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    const counter = await harness.db.execute<{ next_seq: number }>(sql`
      SELECT next_seq FROM project_iss_counters WHERE project_id = ${project.id}
    `);
    expect(Number((counter[0] as { next_seq: number }).next_seq)).toBe(N + 1);
  });

  it('ISS-* generator: counters are independent per project', async () => {
    const owner = await createTestUser(harness.db);
    const projectA = await createTestProject(harness.db, owner.id, { slug: 'proj-a' });
    const projectB = await createTestProject(harness.db, owner.id, { slug: 'proj-b' });

    for (let i = 0; i < 3; i++) {
      await harness.db.execute(sql`
        INSERT INTO issues (project_id, title, created_by_id)
        VALUES (${projectA.id}, ${`A-${i}`}, ${owner.id})
      `);
    }
    await harness.db.execute(sql`
      INSERT INTO issues (project_id, title, created_by_id)
      VALUES (${projectB.id}, 'B-only', ${owner.id})
    `);

    const aRows = await harness.db.execute<{ iss_seq: number }>(
      sql`SELECT iss_seq FROM issues WHERE project_id = ${projectA.id} ORDER BY iss_seq`,
    );
    const bRows = await harness.db.execute<{ iss_seq: number }>(
      sql`SELECT iss_seq FROM issues WHERE project_id = ${projectB.id} ORDER BY iss_seq`,
    );
    expect(aRows.map((r) => Number((r as { iss_seq: number }).iss_seq))).toEqual([1, 2, 3]);
    expect(bRows.map((r) => Number((r as { iss_seq: number }).iss_seq))).toEqual([1]);
  });

  it('project invitation flow: partial-unique blocks duplicate pending invites', async () => {
    const owner = await createTestUser(harness.db);
    const invitee = await createTestUser(harness.db, { email: 'invitee@test.local' });
    const project = await createTestProject(harness.db, owner.id);
    await createTestProjectMember(harness.db, {
      userId: owner.id,
      projectId: project.id,
      role: 'admin',
    });

    await harness.db.execute(sql`
      INSERT INTO project_invitations (token, project_id, email, role, inviter_id, expires_at)
      VALUES ('tok-1', ${project.id}, 'invitee@test.local', 'member', ${owner.id}, now() + interval '60 seconds')
    `);

    let dupErr: unknown;
    try {
      await harness.db.execute(sql`
        INSERT INTO project_invitations (token, project_id, email, role, inviter_id, expires_at)
        VALUES ('tok-2', ${project.id}, 'invitee@test.local', 'member', ${owner.id}, now() + interval '60 seconds')
      `);
    } catch (err) {
      dupErr = err;
    }
    expect(dupErr).toBeDefined();
    const pgCode =
      (dupErr as { code?: string })?.code ?? (dupErr as { cause?: { code?: string } })?.cause?.code;
    expect(pgCode).toBe('23505');

    await harness.db.execute(sql`
      UPDATE project_invitations SET accepted_at = now() WHERE token = 'tok-1'
    `);
    await harness.db.execute(sql`
      INSERT INTO project_invitations (token, project_id, email, role, inviter_id, expires_at)
      VALUES ('tok-3', ${project.id}, 'invitee@test.local', 'member', ${owner.id}, now() + interval '60 seconds')
    `);

    await harness.db.execute(sql`
      INSERT INTO project_members (user_id, project_id, role)
      VALUES (${invitee.id}, ${project.id}, 'member')
    `);

    const members = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM project_members WHERE project_id = ${project.id}`,
    );
    expect((members[0] as { count: string }).count).toBe('2');
  });

  it('project_invitations cascade when project is deleted', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    await createTestProjectMember(harness.db, {
      userId: owner.id,
      projectId: project.id,
      role: 'admin',
    });

    await harness.db.execute(sql`
      INSERT INTO project_invitations (token, project_id, email, role, inviter_id, expires_at)
      VALUES ('tok-x', ${project.id}, 'x@e.co', 'member', ${owner.id}, now() + interval '60 seconds')
    `);

    await harness.db.execute(sql`DELETE FROM projects WHERE id = ${project.id}`);

    const rows = await harness.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM project_invitations`,
    );
    expect((rows[0] as { count: string }).count).toBe('0');
  });

  it('cascading deletes: removing a project wipes its issues, comments, labels, counter', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);

    const issueRows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO issues (project_id, title, created_by_id)
      VALUES (${project.id}, 'doomed', ${owner.id})
      RETURNING id
    `);
    const issueId = (issueRows[0] as { id: string }).id;

    await harness.db.execute(sql`
      INSERT INTO comments (issue_id, author_id, body)
      VALUES (${issueId}, ${owner.id}, 'hi')
    `);
    await harness.db.execute(sql`
      INSERT INTO labels (project_id, name, color) VALUES (${project.id}, 'bug', '#f00')
    `);

    await harness.db.execute(sql`DELETE FROM projects WHERE id = ${project.id}`);

    for (const table of ['issues', 'comments', 'labels', 'project_iss_counters']) {
      const rows = await harness.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM ${sql.identifier(table)}`,
      );
      expect((rows[0] as { count?: string } | undefined)?.count).toBe('0');
    }
  });
});
