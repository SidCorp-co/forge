/**
 * ISS-940 — a second `mark_merged` does not move the timestamp, and must say so.
 *
 * The first stamp wins by design (ISS-286). What was missing is that the caller
 * was told `merged_at` either way, so a corrected note landed beside a value
 * some earlier write set — observed 2026-09-07 on ISS-925, where a throwaway
 * probe claimed the timestamp and the real note never moved it.
 *
 * Only a real Postgres can fail this: the answer turns on whether the row was
 * NULL *before* the UPDATE, and `RETURNING` reports the row AFTER it.
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

describe('ISS-940 re-marking an already-merged issue (real Postgres)', () => {
  let harness: TestDatabase;
  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    userId = (await createTestUser(harness.db)).id;
    projectId = (await createTestProject(harness.db, userId)).id;
  });

  async function insertIssue(): Promise<{ id: string; projectId: string; mergedAt: null }> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, session_context)
      VALUES (${id}, ${projectId}, 1, 'marker specimen', 'open', ${userId},
              ${JSON.stringify({ branch: 'ISS-1' })}::jsonb)
    `);
    return { id, projectId, mergedAt: null };
  }

  const actor = () => ({
    agency: 'human' as const,
    commentAuthorId: userId,
    hookActor: { type: 'user' as const, id: userId, agency: 'human' as const },
  });

  async function mark(
    issue: { id: string; projectId: string; mergedAt: Date | null },
    note: string,
  ) {
    const { applyMergeMarker } = await import('../../src/issues/merge-marker.js');
    return applyMergeMarker({ issue, op: 'mark', target: 'main', note, actor: actor() });
  }

  async function mergedAtOf(id: string): Promise<string | null> {
    const [row] = await harness.db.execute<{ merged_at: string | null }>(
      sql`SELECT merged_at FROM issues WHERE id = ${id}`,
    );
    return row?.merged_at ?? null;
  }

  it('answers `merged` for the call that actually stamps', async () => {
    const issue = await insertIssue();

    const res = await mark(issue, 'the real landing');

    expect(res.action).toBe('merged');
    expect(await mergedAtOf(issue.id)).not.toBeNull();
  });

  // cm:guard this is the ISS-925 shape and the assertion that matters: the SECOND call must not answer `merged`. Before this change both calls answered identically while only the first wrote, which is the whole defect.
  it('answers `already_merged` for a second call, and does not move the timestamp', async () => {
    const issue = await insertIssue();
    await mark(issue, 'probe');
    const first = await mergedAtOf(issue.id);

    const res = await mark({ ...issue, mergedAt: new Date(first as string) }, 'the real landing');

    expect(res.action).toBe('already_merged');
    expect(await mergedAtOf(issue.id)).toBe(first);
  });

  it('says in the audit trail that the timestamp belongs to an earlier write', async () => {
    const issue = await insertIssue();
    await mark(issue, 'probe');
    await mark({ ...issue, mergedAt: new Date() }, 'the real landing');

    const rows = await harness.db.execute<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${issue.id} ORDER BY created_at ASC`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.body).not.toMatch(/NOT stamped by this call/);
    expect(rows[1]?.body).toMatch(/NOT stamped by this call/);
    expect(rows[1]?.body).toMatch(/unmark/);
  });

  it('lets unmark then mark actually move it', async () => {
    const issue = await insertIssue();
    await mark(issue, 'probe');
    const first = await mergedAtOf(issue.id);

    const { applyMergeMarker } = await import('../../src/issues/merge-marker.js');
    await applyMergeMarker({
      issue: { ...issue, mergedAt: new Date(first as string) },
      op: 'unmark',
      actor: actor(),
    });
    const res = await mark(issue, 'the real landing');

    expect(res.action).toBe('merged');
    expect(await mergedAtOf(issue.id)).not.toBe(first);
  });

  it('honours an explicit mergedAt on the first stamp', async () => {
    const issue = await insertIssue();
    const when = new Date('2026-09-01T12:00:00.000Z');
    const { applyMergeMarker } = await import('../../src/issues/merge-marker.js');

    const res = await applyMergeMarker({
      issue,
      op: 'mark',
      target: 'main',
      mergedAt: when,
      actor: actor(),
    });

    expect(res.action).toBe('merged');
    expect(new Date(String(await mergedAtOf(issue.id))).toISOString()).toBe(when.toISOString());
  });
});
