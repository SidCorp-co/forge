/**
 * ISS-83 — a comment sits on exactly one of issue | requirement | workflow design | feedback, and a
 * decision on a requirement carries its decision and reason as fields. The table refuses every
 * other shape on its own, so a door that forgot to check still cannot write an orphan or a twin.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let userId: string;
let issueId: string;
let requirementId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
});

afterAll(async () => {
  await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db)).id;
  const projectId = (await createTestProject(harness.db, userId)).id;
  issueId = randomUUID();
  requirementId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${issueId}, ${projectId}, 83, 'a target', 'open', ${userId})
  `);
  await harness.db.execute(sql`
    INSERT INTO requirements (id, project_id, req_seq, title)
    VALUES (${requirementId}, ${projectId}, 3, 'a requirement')
  `);
});

async function refusalOf(statement: ReturnType<typeof sql>): Promise<string | null> {
  try {
    await harness.db.execute(statement);
    return null;
  } catch (err) {
    const cause = (err as { cause?: { constraint_name?: string; message?: string } }).cause;
    return cause?.constraint_name ?? cause?.message ?? String(err);
  }
}

describe('comments_scope_chk', () => {
  it('takes a comment on an issue and on a requirement', async () => {
    expect(
      await refusalOf(sql`
        INSERT INTO comments (issue_id, author_id, body) VALUES (${issueId}, ${userId}, 'on an issue')`),
    ).toBeNull();
    expect(
      await refusalOf(sql`
        INSERT INTO comments (requirement_id, author_id, body) VALUES (${requirementId}, ${userId}, 'on a requirement')`),
    ).toBeNull();
  });

  it('refuses a comment that names no target', async () => {
    expect(
      await refusalOf(sql`INSERT INTO comments (author_id, body) VALUES (${userId}, 'orphan')`),
    ).toBe('comments_scope_chk');
  });

  it('refuses a comment that names two targets', async () => {
    expect(
      await refusalOf(sql`
        INSERT INTO comments (issue_id, requirement_id, author_id, body)
        VALUES (${issueId}, ${requirementId}, ${userId}, 'twin')`),
    ).toBe('comments_scope_chk');
  });

  it('refuses an update that moves a comment onto a second target', async () => {
    await harness.db.execute(
      sql`INSERT INTO comments (issue_id, author_id, body) VALUES (${issueId}, ${userId}, 'x')`,
    );
    expect(await refusalOf(sql`UPDATE comments SET requirement_id = ${requirementId}`)).toBe(
      'comments_scope_chk',
    );
  });

  it('takes a requirement comment away with the requirement', async () => {
    await harness.db.execute(sql`
      INSERT INTO comments (requirement_id, author_id, body) VALUES (${requirementId}, ${userId}, 'x')`);
    await harness.db.execute(sql`DELETE FROM requirements WHERE id = ${requirementId}`);
    const rows = await harness.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM comments WHERE requirement_id IS NOT NULL`,
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

describe('a decision carries its reason as fields', () => {
  const requirementDecision = (decision: string) => sql`
    INSERT INTO comments (requirement_id, author_id, body, intent, decision)
    VALUES (${requirementId}, ${userId}, 'd', 'decision', ${decision}::text::jsonb)`;

  it('takes a decision with both fields', async () => {
    expect(
      await refusalOf(
        requirementDecision(JSON.stringify({ decision: 'Keep D1', reason: 'owner' })),
      ),
    ).toBeNull();
  });

  it('refuses a requirement decision with no reason, a blank reason, and none at all', async () => {
    expect(await refusalOf(requirementDecision(JSON.stringify({ decision: 'Keep D1' })))).toBe(
      'comments_decision_fields_chk',
    );
    expect(
      await refusalOf(requirementDecision(JSON.stringify({ decision: 'Keep D1', reason: '  ' }))),
    ).toBe('comments_decision_fields_chk');
    expect(
      await refusalOf(sql`
        INSERT INTO comments (requirement_id, author_id, body, intent)
        VALUES (${requirementId}, ${userId}, 'prose', 'decision')`),
    ).toBe('comments_decision_fields_chk');
  });

  it('refuses decision fields on a note', async () => {
    expect(
      await refusalOf(sql`
        INSERT INTO comments (requirement_id, author_id, body, intent, decision)
        VALUES (${requirementId}, ${userId}, 'n', 'note', '{"decision":"a","reason":"b"}'::jsonb)`),
    ).toBe('comments_decision_intent_chk');
  });
});

describe('a comment event is insert-only', () => {
  it('refuses an update of an event, and lets the comment take its events with it', async () => {
    const [comment] = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO comments (requirement_id, author_id, body) VALUES (${requirementId}, ${userId}, 'x') RETURNING id`);
    const commentId = (comment as { id: string }).id;
    await harness.db.execute(sql`
      INSERT INTO comment_events (project_id, comment_id, kind, body, actor_id, actor_agency)
      SELECT project_id, ${commentId}, 'posted', 'x', ${userId}, 'human' FROM requirements WHERE id = ${requirementId}`);
    expect(await refusalOf(sql`UPDATE comment_events SET body = 'rewritten'`)).toContain(
      'COMMENT_EVENT_IMMUTABLE',
    );
    expect(await refusalOf(sql`DELETE FROM comment_events`)).toContain('COMMENT_EVENT_IMMUTABLE');
    expect(await refusalOf(sql`DELETE FROM comments WHERE id = ${commentId}`)).toBeNull();
  });
});
