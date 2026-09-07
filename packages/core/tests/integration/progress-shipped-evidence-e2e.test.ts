/**
 * ISS-817 — `merged_at` alone is not shipped-evidence. `markMergedOnClose`
 * stamps it on EVERY close whose column is still null, so the predicate's
 * second disjunct degenerated to "closed after ever reaching developed" and
 * an issue whose code never merged was reported as shipped.
 *
 * The unit suite (`src/issues/progress.test.ts`) fakes the query builder and
 * never executes the `where`/`groupBy` SQL, so it cannot see this predicate at
 * all. This runs it against real Postgres.
 *
 * The discriminator under test is a timestamp identity: the auto-stamp and the
 * close's `activity_log` row are written in ONE transaction, and Postgres
 * `now()` is transaction-start time, so both land on the same instant. A
 * genuine base-merge stamp was written in an earlier, separate transaction.
 * That is a real coupling to how the two writes are sequenced — if it is ever
 * broken, `stamped_at_close` below fails rather than the figure silently
 * drifting back up.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

describe('ISS-817 computeProjectProgress shipped-evidence', () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  });

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  const CLOSED_AT = new Date('2026-08-01T10:00:00Z');
  const MERGED_EARLIER = new Date('2026-07-30T09:00:00Z');

  async function insertIssue(
    projectId: string,
    ownerId: string,
    title: string,
    status: string,
    mergedAt: Date | null,
  ): Promise<string> {
    const rows = await harness.db.execute<{ id: string }>(sql`
      INSERT INTO issues (project_id, title, status, created_by_id, merged_at)
      VALUES (${projectId}, ${title}, ${status}, ${ownerId},
              ${mergedAt ? mergedAt.toISOString() : null}::timestamptz)
      RETURNING id
    `);
    return (rows[0] as { id: string }).id;
  }

  async function logTransition(
    issueId: string,
    ownerId: string,
    to: string,
    at: Date,
  ): Promise<void> {
    await harness.db.execute(sql`
      INSERT INTO activity_log (issue_id, actor_type, actor_id, action, payload, created_at)
      VALUES (${issueId}, 'user', ${ownerId}, 'issue.statusChanged',
              ${JSON.stringify({ from: 'x', to })}::jsonb, ${at.toISOString()}::timestamptz)
    `);
  }

  it('excludes a close-time auto-stamp while still counting a genuine hand-merge', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);

    // cm:why merged_at EQUALS the close instant — the auto-stamp signature; this issue's code never merged
    const i1 = await insertIssue(
      project.id,
      owner.id,
      'auto-stamped-on-close',
      'closed',
      CLOSED_AT,
    );
    await logTransition(i1, owner.id, 'developed', new Date('2026-07-31T10:00:00Z'));
    await logTransition(i1, owner.id, 'closed', CLOSED_AT);

    await insertIssue(project.id, owner.id, 'closed-bare', 'closed', null);

    const i3 = await insertIssue(project.id, owner.id, 'released', 'released', CLOSED_AT);
    await logTransition(i3, owner.id, 'released', CLOSED_AT);

    await insertIssue(project.id, owner.id, 'in-flight', 'in_progress', null);

    // cm:why the case ISS-817's option 3 would have lost — merged by hand a day EARLIER than the close, so merged_at is real evidence and must still count
    const i5 = await insertIssue(
      project.id,
      owner.id,
      'hand-merged-then-closed',
      'closed',
      MERGED_EARLIER,
    );
    await logTransition(i5, owner.id, 'developed', new Date('2026-07-30T08:00:00Z'));
    await logTransition(i5, owner.id, 'closed', CLOSED_AT);

    // cm:why imported here, not at module scope — src/issues/progress.ts pulls in db/client.js, which validates env at load time and would throw before beforeAll sets DATABASE_URL
    const { computeProjectProgress } = await import('../../src/issues/progress.js');
    const progress = await computeProjectProgress(project.id, harness.db as never);

    expect(progress).not.toBeNull();
    expect(progress?.shipped).toBe(2);
    expect(progress?.closedUnshipped).toBe(2);
    expect(progress?.inFlight).toBe(1);
    expect(progress?.remaining).toBe(0);
    expect(progress?.total).toBe(5);
  });

  // cm:why ISS-791 — work driven entirely by hand never logs a transition into developed/testing/tested/released, so the predicate's old `reachedPostCode` conjunct discarded the ONE audited claim that the work shipped and reported it as "closed with no evidence it shipped"
  it('counts a hand-driven close that never entered a pipeline status but carries an explicit merge stamp', async () => {
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);

    const byHand = await insertIssue(
      project.id,
      owner.id,
      'hand-driven-never-in-pipeline',
      'closed',
      MERGED_EARLIER,
    );
    await logTransition(byHand, owner.id, 'closed', CLOSED_AT);

    // cm:guard the ISS-817 property must survive this widening or it is not a widening but a regression: an issue whose merged_at was written BY its own close is still not evidence
    const autoStamped = await insertIssue(
      project.id,
      owner.id,
      'hand-driven-auto-stamped',
      'closed',
      CLOSED_AT,
    );
    await logTransition(autoStamped, owner.id, 'closed', CLOSED_AT);

    const { computeProjectProgress } = await import('../../src/issues/progress.js');
    const progress = await computeProjectProgress(project.id, harness.db as never);

    expect(progress?.shipped).toBe(1);
    expect(progress?.closedUnshipped).toBe(1);
    expect(progress?.total).toBe(2);
  });

  it('stamped_at_close: the auto-stamp really does land on the close instant', async () => {
    // cm:guard this pins the assumption the shipped predicate rests on — if a refactor splits the stamp out of the close's transaction, fail HERE rather than silently re-inflating the shipped figure
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    const issueId = await insertIssue(project.id, owner.id, 'stamp-probe', 'developed', null);

    // cm:why mirrors apply-transition.ts — one transaction for both writes is what makes the timestamps equal
    await harness.db.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE issues SET merged_at = now() WHERE id = ${issueId} AND merged_at IS NULL`,
      );
      await tx.execute(sql`
        INSERT INTO activity_log (issue_id, actor_type, actor_id, action, payload)
        VALUES (${issueId}, 'user', ${owner.id}, 'issue.statusChanged',
                ${JSON.stringify({ from: 'developed', to: 'closed' })}::jsonb)
      `);
    });

    const rows = await harness.db.execute<{ same: boolean }>(sql`
      SELECT (i.merged_at = a.created_at) AS same
      FROM issues i JOIN activity_log a ON a.issue_id = i.id
      WHERE i.id = ${issueId}
    `);
    expect((rows[0] as { same: boolean }).same).toBe(true);
  });
});
