/**
 * ISS-1381 r6 — the four guards of the close-failure read that no test held (judge j6, comment
 * d83596a4): each is here with a case that goes red when it is removed.
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

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

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

const PLANT = (id: string) =>
  sql.raw(`ALTER TABLE issues ADD CONSTRAINT gj_closed_needs_ledger
    CHECK (status <> 'closed' OR id <> '${id}') NOT VALID`);
const UNPLANT = sql.raw('ALTER TABLE issues DROP CONSTRAINT IF EXISTS gj_closed_needs_ledger');

/** The banner the issue's page reads: the roster's closeFailure for it. */
async function bannerFailure(issueId: string): Promise<{ version: string | null } | null> {
  const res: Response = await app.request(`/api/projects/${projectId}/release-batches/roster`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    issues: Array<{ id: string; closeFailure: { version: string | null } | null }>;
  };
  const row = body.issues.find((i) => i.id === issueId);
  expect(row, 'the issue is on the roster').toBeDefined();
  return row?.closeFailure ?? null;
}

/** A recorded move of an issue, as the status chokepoint writes it, stamped now. */
async function recordMove(issueId: string, from: string, to: string, ago = '0 seconds') {
  await harness.db.execute(sql`
    INSERT INTO kernel_transitions
      (entity, entity_id, from_status, to_status, actor_type, source, created_at)
    VALUES ('issue', ${issueId}, ${from}, ${to}, 'user', 'test', now() - ${ago}::interval)
  `);
}

/** One issue whose release's finish failed to close it, on a planted check constraint. */
async function failedClose(): Promise<{ issue: string; version: string }> {
  const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
  const issue = await fx.insertIssue();
  await harness.db.execute(PLANT(issue));
  const claimed = await fx.claim([issue]);
  await finishReleaseBatch(claimed.runId, { type: 'user', id: ownerId });
  await harness.db.execute(UNPLANT);
  expect((await bannerFailure(issue))?.version).toBe(claimed.version);
  return { issue, version: claimed.version };
}

describe("a close failure stands against another issue's moves", () => {
  it('is not ended by a close or a reopen of another issue after it', async () => {
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const { lastCloseFailures } = await import('../../src/release-batch/close-failures.js');
    const failing = await fx.insertIssue();
    const closing = await fx.insertIssue();
    await harness.db.execute(PLANT(failing));
    try {
      const claimed = await fx.claim([failing, closing]);
      const done = await finishReleaseBatch(claimed.runId, { type: 'user', id: ownerId });
      expect(done.closed).toEqual([closing]);

      await recordMove(closing, 'closed', 'awaiting_release');
      await recordMove(closing, 'awaiting_release', 'closed');

      expect((await bannerFailure(failing))?.version).toBe(claimed.version);
      const stored = await lastCloseFailures(projectId, [failing, closing]);
      expect([...stored.keys()]).toEqual([failing]);
    } finally {
      await harness.db.execute(UNPLANT);
    }
  });
});

describe('a close failure ends at a recorded move into or out of closed after it', () => {
  it('stands through a move that touches neither side of closed', async () => {
    const { issue, version } = await failedClose();
    await recordMove(issue, 'awaiting_release', 'in_progress');
    expect((await bannerFailure(issue))?.version).toBe(version);
  });

  it('stands against a close recorded before it', async () => {
    const { issue, version } = await failedClose();
    await recordMove(issue, 'awaiting_release', 'closed', '1 hour');
    expect((await bannerFailure(issue))?.version).toBe(version);
  });

  // A status written outside the chokepoint leaves no row (`unaudited_transitions` is where that
  // is caught), so the other half of a close and a reopen may be the only one on record.
  it('ends at a recorded close whose reopen was written unrecorded', async () => {
    const { issue } = await failedClose();
    await recordMove(issue, 'awaiting_release', 'closed');
    expect(await bannerFailure(issue)).toBeNull();
  });

  it('ends at a recorded reopen whose close was written unrecorded', async () => {
    const { issue } = await failedClose();
    await recordMove(issue, 'closed', 'awaiting_release');
    expect(await bannerFailure(issue)).toBeNull();
  });
});

describe('the latest close failure is the latest in time, however its stamp is written', () => {
  const A = (at: string, reason: string) => ({ kind: 'failed', reason, version: null, at });

  async function plant(runId: string, issue: string, record: object) {
    await harness.db.execute(sql`
      UPDATE pipeline_runs
         SET metadata = coalesce(metadata, '{}'::jsonb)
               || jsonb_build_object('closeFailures',
                    jsonb_build_object(${issue}::text, ${JSON.stringify(record)}::jsonb))
       WHERE id = ${runId}
    `);
  }

  it.each([
    ['an offset other than UTC', '2026-10-08T11:00:00+07:00', '2026-10-08T04:30:00+00:00'],
    [
      'a stamp written as JavaScript wrote it, beside one the database wrote',
      '2026-10-08T04:30:00.9Z',
      '2026-10-08T04:30:00.95+00:00',
    ],
  ])('reads the later of two stamps with %s', async (_name, earlier, later) => {
    const { lastCloseFailures } = await import('../../src/release-batch/close-failures.js');
    const issue = await fx.insertIssue();
    const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
    const holdsLater = await fx.claim([await fx.insertIssue()]);
    await finishReleaseBatch(holdsLater.runId, { type: 'user', id: ownerId });
    const holdsEarlier = await fx.claim([await fx.insertIssue()]);
    await plant(holdsLater.runId, issue, A(later, 'the later failure'));
    await plant(holdsEarlier.runId, issue, A(earlier, 'the earlier failure'));

    const read = (await lastCloseFailures(projectId, [issue])).get(issue);

    expect(read?.reason).toBe('the later failure');
    expect(read?.runId).toBe(holdsLater.runId);
  });

  it('stamps a failure after a close that landed while its write waited on the run', async () => {
    const { sayCloseFailure, lastCloseFailures } = await import(
      '../../src/release-batch/close-failures.js'
    );
    const issue = await fx.insertIssue();
    const run = await fx.claim([await fx.insertIssue()]);

    let saying: Promise<void> | null = null;
    await harness.client.begin(async (tx) => {
      // An UPDATE, not a bare lock: only a row that changed under the waiting write is evaluated again.
      await tx`UPDATE pipeline_runs SET updated_at = now() WHERE id = ${run.runId}`;
      saying = sayCloseFailure({
        runId: run.runId,
        projectId,
        issueId: issue,
        authorId: ownerId,
        kind: 'failed',
        reason: 'the write waited',
        version: run.version,
        body: () => 'the failure',
      });
      await fx.waitFor(async () => {
        const waiting = await harness.db.execute(sql`
          SELECT 1 FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query LIKE '%closeFailures%'
             AND datname = current_database()
        `);
        return waiting.length > 0;
      });
      // The close is stamped by its own transaction, after the write began and before it ran.
      await recordMove(issue, 'awaiting_release', 'closed');
    });
    await saying;

    // The failure came after that close: it is the issue's latest word, not a record the close ended.
    expect((await lastCloseFailures(projectId, [issue])).get(issue)?.reason).toBe(
      'the write waited',
    );
  });
});
