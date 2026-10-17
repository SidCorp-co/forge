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

  async function insertIssue(): Promise<{
    id: string;
    projectId: string;
    mergedAt: null;
    declaredLandingShape: null;
  }> {
    const id = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, session_context)
      VALUES (${id}, ${projectId}, 1, 'marker specimen', 'open', ${userId},
              ${JSON.stringify({ branch: 'ISS-1' })}::jsonb)
    `);
    return { id, projectId, mergedAt: null, declaredLandingShape: null };
  }

  const actor = () => ({
    agency: 'human' as const,
    commentAuthorId: userId,
    hookActor: { type: 'user' as const, id: userId, agency: 'human' as const },
  });

  async function mark(
    issue: { id: string; projectId: string; mergedAt: Date | null; declaredLandingShape: null },
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
    expect(rows[0]?.body).toMatch(/^Marked merged into main/);
    expect(rows[1]?.body).toMatch(
      /^Already marked merged on \d{1,2} [A-Z][a-z]{2} \d{4}, so this call changed nothing/,
    );
    expect(rows[1]?.body).toMatch(/To change the mark, use Unmark, then Mark merged again\./);
  });

  // ISS-1421 criterion 63: a call that marked nothing never opens "Marked merged", shouts no word of
  // its own and prints no stored timestamp, in the thread or in the caller's answer.
  it('words a repeat as a call that changed nothing, in short whole sentences', async () => {
    const issue = await insertIssue();
    await mark(issue, 'probe');
    const { applyMergeMarker } = await import('../../src/issues/merge-marker.js');
    const again = await applyMergeMarker({ issue, op: 'mark', target: 'main', actor: actor() });

    const [last] = await harness.db.execute<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${issue.id} ORDER BY created_at DESC LIMIT 1`,
    );
    for (const text of [last?.body ?? '', again.markDetail]) {
      expect(text).not.toMatch(/^Marked merged/m);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(text).not.toMatch(/\b[A-Z]{2,}\b/);
      for (const sentence of text.split(/(?<=\.)\s+/)) {
        expect(sentence).toMatch(/^[A-Z]/);
        expect(sentence).toMatch(/\.$/);
        expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(20);
      }
    }
    expect(again.markDetail).toMatch(
      /^Already marked merged on .+, so this call changed nothing\./,
    );
  });

  it('refuses an unmark with no mark by name, and writes no comment', async () => {
    const issue = await insertIssue();
    const { applyMergeMarker, MergeMarkerError } = await import('../../src/issues/merge-marker.js');
    const err = await applyMergeMarker({ issue, op: 'unmark', actor: actor() }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MergeMarkerError);
    expect((err as InstanceType<typeof MergeMarkerError>).code).toBe('NOT_MARKED_MERGED');
    expect((err as Error).message).toBe(
      'This issue is not marked merged, so there is no mark to remove. Nothing changed.',
    );
    const rows = await harness.db.execute(sql`SELECT 1 FROM comments WHERE issue_id = ${issue.id}`);
    expect(rows).toHaveLength(0);
  });

  it("leaves the caller's note whole on its own line, after the sentence saying nothing changed", async () => {
    const issue = await insertIssue();
    const note =
      'merged to main at abc1234; landing moved nothing; landing wrote packages/core/src/a.ts';
    await mark(issue, 'probe');
    await mark({ ...issue, mergedAt: new Date() }, note);

    const rows = await harness.db.execute<{ body: string }>(
      sql`SELECT body FROM comments WHERE issue_id = ${issue.id} ORDER BY created_at ASC`,
    );
    const [first, kept, ...rest] = (rows[1]?.body ?? '').split('\n\n');
    expect(first).toMatch(/^Already marked merged on .+, so this call changed nothing\.$/);
    expect(kept).toBe(`> ${note}`);
    expect(/\blanding wrote ([^;\n]+)/u.exec(rows[1]?.body ?? '')?.[1]).toBe(
      'packages/core/src/a.ts',
    );
    expect(rest.join('\n')).toMatch(/^To change the mark, use Unmark, then Mark merged again\./);
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
