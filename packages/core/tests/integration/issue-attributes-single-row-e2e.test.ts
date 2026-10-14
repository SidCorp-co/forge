/**
 * ISS-1132 — a single-row attribute key is one row per issue because the database says so.
 *
 * Before the partial unique index, `cardinality: 'one'` was a delete-then-insert two concurrent
 * writers both passed under READ COMMITTED: both deleted nothing, both inserted, and the issue held
 * two rows for a key that promised one. Against real Postgres, because the claim is about what two
 * transactions leave behind.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { singleRowAttributeKeys } from '../../src/db/issue-vocabulary.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let setIssueAttributes: typeof import('../../src/issues/attributes/service.js')['setIssueAttributes'];

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
  setIssueAttributes = (await import('../../src/issues/attributes/service.js')).setIssueAttributes;
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function anIssue(): Promise<string> {
  const user = await createTestUser(harness.db);
  const project = await createTestProject(harness.db, user.id);
  const rows = await harness.db.execute<{ id: string }>(sql`
    INSERT INTO issues (project_id, title, created_by_id)
    VALUES (${project.id}, 'the subject', ${user.id}) RETURNING id
  `);
  return (rows[0] as { id: string }).id;
}

async function rowsOf(issueId: string, key: string) {
  return harness.db.execute<{ id: string; value_bool: boolean | null; value_text: string | null }>(
    sql`SELECT id, value_bool, value_text FROM issue_attributes WHERE issue_id = ${issueId} AND key = ${key}`,
  );
}

const insertRaw = (issueId: string, key: string) =>
  harness.db.execute(
    sql`INSERT INTO issue_attributes (issue_id, key, value_text) VALUES (${issueId}, ${key}, 'x')`,
  );

describe('the database refuses a second row for a single-row key', () => {
  it.each([...singleRowAttributeKeys])('%s holds one row per issue', async (key) => {
    const issueId = await anIssue();
    await insertRaw(issueId, key);
    const failure = await insertRaw(issueId, key).then(
      () => '',
      (err: { message?: string; cause?: { message?: string } }) =>
        `${err.message ?? ''} ${err.cause?.message ?? ''}`,
    );
    expect(failure).toContain('issue_attributes_single_row_uq');
    expect(await rowsOf(issueId, key)).toHaveLength(1);
  });

  it('still holds one row for the same key on each of two issues', async () => {
    const [a, b] = [await anIssue(), await anIssue()];
    await insertRaw(a, 'delivered');
    await insertRaw(b, 'delivered');
    expect(await rowsOf(a, 'delivered')).toHaveLength(1);
    expect(await rowsOf(b, 'delivered')).toHaveLength(1);
  });

  it('accepts many rows of a many-row key', async () => {
    const issueId = await anIssue();
    await insertRaw(issueId, 'obligation');
    await insertRaw(issueId, 'obligation');
    expect(await rowsOf(issueId, 'obligation')).toHaveLength(2);
  });
});

describe('two writers of one single-row key leave one row', () => {
  /** Polls until a backend is waiting on a lock, which is what makes the interleaving a fact rather than a hope. */
  async function waitForBlockedInsert(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const rows = await harness.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE '%insert%issue_attributes%'
      `);
      if ((rows[0] as { n: number }).n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the writer never blocked on the row the held transaction inserted');
  }

  it('keeps the value of the write the database serialized second', async () => {
    const issueId = await anIssue();
    const held = await harness.client.reserve();
    let second: ReturnType<typeof setIssueAttributes> | null = null;
    try {
      await held.unsafe('BEGIN');
      await held.unsafe(
        `INSERT INTO issue_attributes (issue_id, key, value_bool) VALUES ($1, 'human_required', true)`,
        [issueId],
      );
      second = setIssueAttributes([{ issueId, key: 'human_required', value: false }]);
      await waitForBlockedInsert();
      await held.unsafe('COMMIT');
    } finally {
      held.release();
    }
    await second;

    const rows = await rowsOf(issueId, 'human_required');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value_bool).toBe(false);
  });

  it('leaves one row when both writers go through the writer at once', async () => {
    const issueId = await anIssue();
    await Promise.all([
      setIssueAttributes([{ issueId, key: 'human_required', value: true }]),
      setIssueAttributes([{ issueId, key: 'human_required', value: false }]),
      setIssueAttributes([{ issueId, key: 'irreversible_if_wrong', value: 'a' }]),
      setIssueAttributes([{ issueId, key: 'irreversible_if_wrong', value: 'b' }]),
    ]);
    expect(await rowsOf(issueId, 'human_required')).toHaveLength(1);
    expect(await rowsOf(issueId, 'irreversible_if_wrong')).toHaveLength(1);
  });

  it('replaces the value of a key it already holds, keeping one row', async () => {
    const issueId = await anIssue();
    await setIssueAttributes([{ issueId, key: 'irreversible_if_wrong', value: 'first' }]);
    await setIssueAttributes([{ issueId, key: 'irreversible_if_wrong', value: 'second' }]);
    const rows = await rowsOf(issueId, 'irreversible_if_wrong');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value_text).toBe('second');
  });
});
