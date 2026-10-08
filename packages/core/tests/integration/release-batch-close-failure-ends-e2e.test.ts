/**
 * ISS-1381 r5 — a close failure stayed on the issue after a release closed it: once the issue came
 * back to the gate, its banner and gate row still said Release now fails the same way, and the next
 * failure rewrote the comment from before the close (judge j5, comment 095cbc18).
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let token: string;
// The roster route the issue page's release banner and the release gate panel read.
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
  const [batch, err] = await Promise.all([
    import('../../src/release-batch/routes.js'),
    import('../../src/middleware/error.js'),
  ]);
  app = new Hono();
  app.route('/api/projects', batch.releaseBatchRoutes);
  app.onError(err.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  ownerId = owner.id;
  token = await (await import('../../src/auth/jwt.js')).signUserToken(owner.id);
  projectId = (await createTestProject(harness.db, owner.id)).id;
  await createTestProjectMember(harness.db, { userId: owner.id, projectId, role: 'admin' });
  await fx.declareProduction();
  await fx.seedReleaseRunner();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

interface RosterEntry {
  id: string;
  closeRefusals: Array<{ code: string }>;
  closeFailure: { reason: string; version: string | null } | null;
}

async function bannerEntry(issueId: string) {
  const res: Response = await app.request(`/api/projects/${projectId}/release-batches/roster`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { issues: RosterEntry[] };
  return body.issues.find((i) => i.id === issueId);
}

async function lastComment(issueId: string): Promise<string> {
  const rows = await harness.db.execute(sql`
    SELECT body FROM comments WHERE issue_id = ${issueId} ORDER BY created_at DESC LIMIT 1
  `);
  return String(rows[0]?.body ?? '');
}

describe('a close failure ends at the close after it (ISS-1381 r5)', () => {
  const PLANT = (id: string) =>
    sql.raw(`ALTER TABLE issues ADD CONSTRAINT gj_closed_needs_ledger
      CHECK (status <> 'closed' OR id <> '${id}') NOT VALID`);
  const UNPLANT = sql.raw('ALTER TABLE issues DROP CONSTRAINT IF EXISTS gj_closed_needs_ledger');

  async function failureComments(issueId: string): Promise<Array<{ id: string; body: string }>> {
    const rows = await harness.db.execute(sql`
      SELECT id, body FROM comments
       WHERE issue_id = ${issueId} AND body LIKE '%could not be closed%'
       ORDER BY created_at
    `);
    return rows.map((r) => ({ id: String(r.id), body: String(r.body) }));
  }

  /** Reopened from its page, then landed again: the landing is written as j5 wrote it, by SQL. */
  async function reopenAndLand(issueId: string): Promise<void> {
    const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');
    const [row] = await harness.db.execute(sql`
      SELECT reopen_count FROM issues WHERE id = ${issueId}
    `);
    await transitionIssueStatus(
      { id: issueId, projectId, status: 'closed', reopenCount: Number(row?.reopen_count ?? 0) },
      'reopen',
      { type: 'user', id: ownerId },
      { transitionReason: 'the close missed a case; reworked and landed again' },
    );
    await harness.db.execute(sql`
      UPDATE issues SET status = 'awaiting_release', merged_at = now() WHERE id = ${issueId}
    `);
  }

  it('names no failure once a release closed the issue, and a later failure says itself anew', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const issue = await fx.insertIssue();
    await harness.db.execute(PLANT(issue));
    try {
      const failedFirst = await fx.claim([issue]);
      await finishReleaseBatch(failedFirst.runId, { type: 'user', id: ownerId });
      expect((await bannerEntry(issue))?.closeFailure?.version).toBe(failedFirst.version);
      const [before] = await failureComments(issue);

      await harness.db.execute(UNPLANT);
      const closing = await fx.claim([issue]);
      const closed = await finishReleaseBatch(closing.runId, { type: 'user', id: ownerId });
      expect(closed.closed).toEqual([issue]);
      await reopenAndLand(issue);

      const back = await bannerEntry(issue);
      expect(back?.closeRefusals).toEqual([]);
      expect(back?.closeFailure).toBeNull();

      await harness.db.execute(PLANT(issue));
      const failedAgain = await fx.claim([issue]);
      await finishReleaseBatch(failedAgain.runId, { type: 'user', id: ownerId });

      const said = await failureComments(issue);
      expect(said).toHaveLength(2);
      expect(said[0]).toEqual(before);
      expect(said[1]?.body).toContain(`shipped as version ${failedAgain.version}`);
      expect(said[1]?.body).not.toContain('for the same reason');
      expect(said[1]?.body).not.toContain(`version ${failedFirst.version}`);
      expect((await bannerEntry(issue))?.closeFailure?.version).toBe(failedAgain.version);
    } finally {
      await harness.db.execute(UNPLANT);
    }
  });

  it('says a failure of another kind anew, even where its reason reads the same', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const { sayCloseFailure } = await import('../../src/release-batch/close-failures.js');
    const issue = await fx.insertIssue();
    await harness.db.execute(PLANT(issue));
    try {
      const first = await finishReleaseBatch((await fx.claim([issue])).runId, {
        type: 'user',
        id: ownerId,
      });
      const later = await fx.claim([await fx.insertIssue()]);
      const seen: Array<ReadonlyArray<string | null>> = [];
      await sayCloseFailure({
        runId: later.runId,
        projectId,
        issueId: issue,
        authorId: ownerId,
        kind: 'refused',
        reason: first.failed[0]?.reason ?? '',
        version: later.version,
        body: (repeats) => {
          seen.push(repeats);
          return 'a refusal, not the failure';
        },
      });

      expect(seen).toEqual([[]]);
      expect(await failureComments(issue)).toHaveLength(1);
      expect(await lastComment(issue)).toBe('a refusal, not the failure');
    } finally {
      await harness.db.execute(UNPLANT);
    }
  });

  it('never rewrites a comment on another issue that a stored record points at', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const { sayCloseFailure } = await import('../../src/release-batch/close-failures.js');
    const issue = await fx.insertIssue();
    const other = await fx.insertIssue();
    await harness.db.execute(PLANT(issue));
    try {
      const failed = await fx.claim([issue]);
      const result = await finishReleaseBatch(failed.runId, { type: 'user', id: ownerId });
      const [elsewhere] = await harness.db.execute(sql`
        INSERT INTO comments (issue_id, author_id, body) VALUES (${other}, ${ownerId}, 'not this one')
        RETURNING id
      `);
      await harness.db.execute(sql`
        UPDATE pipeline_runs
           SET metadata = jsonb_set(metadata, ${`{closeFailures,${issue},commentId}`}::text[],
                                    to_jsonb(${String(elsewhere?.id)}::text))
         WHERE id = ${failed.runId}
      `);
      const later = await fx.claim([await fx.insertIssue()]);
      await sayCloseFailure({
        runId: later.runId,
        projectId,
        issueId: issue,
        authorId: ownerId,
        kind: 'failed',
        reason: result.failed[0]?.reason ?? '',
        version: later.version,
        body: () => 'said on its own issue',
      });

      expect(await lastComment(other)).toBe('not this one');
      expect(await lastComment(issue)).toBe('said on its own issue');
    } finally {
      await harness.db.execute(UNPLANT);
    }
  });
});
