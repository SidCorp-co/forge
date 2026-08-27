/**
 * `dropped` vs `closed` against real Postgres.
 *
 * The whole reason the status exists is one column: closing stamps
 * `merged_at`, which unblocks every `blocks` dependent as if the work had
 * shipped, and dropping must not. That is a claim about what a transition
 * writes, so it is worth watching it not happen.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('dropped status E2E', () => {
  let harness: TestDatabase;
  let projectId: string;
  let ownerId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  }, 60_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
  });

  async function insertIssue(seq: number, status: string): Promise<string> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId})
    `);
    return id;
  }

  async function mergedAt(issueId: string): Promise<unknown> {
    const rows = await harness.db.execute(sql`
      SELECT merged_at FROM issues WHERE id = ${issueId}
    `);
    return rows[0]?.merged_at ?? null;
  }

  // cm:guard the CHECK is the defence-in-depth mirror of the TS enum — without it a typo'd status reaches the column and every consumer that switches on status silently takes its default branch
  it('accepts dropped and still refuses a status nobody defined', async () => {
    const id = await insertIssue(1, 'dropped');
    expect(await mergedAt(id)).toBeNull();

    await expect(insertIssue(2, 'abandoned')).rejects.toThrow();
  });

  it('leaves merged_at null when an issue is dropped, and stamps it when closed', async () => {
    const { applyStatusTransition } = await import('../../src/issues/apply-transition.js');
    const dropped = await insertIssue(3, 'open');
    const closed = await insertIssue(4, 'open');
    const actor = { id: ownerId, ownerId } as const;

    // cm:why raw SQL returns snake_case; applyStatusTransition reads the drizzle row shape
    const load = async (id: string) => {
      const rows = await harness.db.execute(sql`
        SELECT id, project_id AS "projectId", status, reopen_count AS "reopenCount"
        FROM issues WHERE id = ${id}
      `);
      return rows[0] as never;
    };

    await applyStatusTransition(await load(dropped), 'dropped', actor, { skip: true });
    await applyStatusTransition(await load(closed), 'closed', actor, { skip: true });

    expect(await mergedAt(dropped)).toBeNull();
    expect(await mergedAt(closed)).not.toBeNull();
  });
});
