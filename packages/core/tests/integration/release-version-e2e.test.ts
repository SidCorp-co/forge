/**
 * ISS-1120 — what the DATABASE refuses once `0291` has run, and the two rules whose absence is
 * invisible until the day they matter.
 *
 * Four things live here rather than in a unit test, because none of them is a rule TypeScript can
 * be asked about:
 *
 *   The duplicate. Two releases wearing one version is the failure the identity rule exists to
 *   stop, and the assertion is on the CONSTRAINT NAME rather than on "it threw" — a NOT NULL or a
 *   foreign key would also throw, and a test that only asserts rejection passes after the rule it
 *   names has been dropped and something else refused the row.
 *
 *   The shape. `highestCutVersion` orders releases by casting the column to an `int[]`, which is
 *   safe only because the CHECK refuses anything that is not three integers.
 *
 *   The burn. A failed release must be shown NOT returning its number — cut, abort, cut again, and
 *   the burned number never reappears. Narrow `highestCutVersion` to completed releases and this
 *   is the test that goes red.
 *
 *   The ship that survives an abort. `cancelConcludedRun` deliberately flips a `completed` run to
 *   `cancelled`, so a reader that asked the run's status would answer an OLDER version for a
 *   project whose newer release is still serving. The stamp is read instead, and this is the test
 *   that goes red if anyone swaps it back.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

describe('a release cuts exactly one version, and that version is its identity', () => {
  let harness: TestDatabase;
  let projectId: string;
  let otherProjectId: string;
  let ownerId: string;
  let db: typeof import('../../src/db/client.js').db;
  let cutReleaseVersion: typeof import('../../src/release-batch/version-store.js').cutReleaseVersion;
  let currentReleaseVersion: typeof import('../../src/release-batch/version-store.js').currentReleaseVersion;
  let markReleaseShipped: typeof import('../../src/release-batch/version-store.js').markReleaseShipped;
  let ReleaseRecutRefusedError: typeof import('../../src/release-batch/errors.js').ReleaseRecutRefusedError;

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
    await registerIntegrationsForTest();

    ({ db } = await import('../../src/db/client.js'));
    ({ cutReleaseVersion, currentReleaseVersion, markReleaseShipped } = await import(
      '../../src/release-batch/version-store.js'
    ));
    ({ ReleaseRecutRefusedError } = await import('../../src/release-batch/errors.js'));
  }, 300_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    ownerId = owner.id;
    projectId = (await createTestProject(harness.db, owner.id)).id;
    otherProjectId = (await createTestProject(harness.db, owner.id)).id;
  });

  const fx = releaseBatchFixture(
    () => harness,
    () => ({ projectId, ownerId }),
  );

  /** A release row exactly as `createReleaseBatch` inserts one, with its version cut in the same
   *  transaction. Returns the run id and the version it cut. */
  async function cutRelease(
    onProject = (): string => projectId,
    recutOf?: string,
  ): Promise<{ runId: string; version: string }> {
    const target = onProject();
    return db.transaction(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO pipeline_runs (project_id, kind, status, metadata)
        VALUES (${target}, 'system', 'running', ${JSON.stringify({ source: 'release-batch' })}::jsonb)
        RETURNING id
      `);
      const runId = rows[0]?.id as string;
      const version = await cutReleaseVersion(tx, { runId, projectId: target, recutOf });
      return { runId, version };
    });
  }

  async function setRunStatus(runId: string, status: string): Promise<void> {
    await db.execute(sql`UPDATE pipeline_runs SET status = ${status} WHERE id = ${runId}`);
  }

  /**
   * Run a statement on the RAW postgres client and hand back what Postgres said. drizzle's
   * `db.execute` replaces the driver's message with `Failed query: ...`, and the constraint name is
   * the whole assertion here — a test that matched on "it threw" would pass after the rule it names
   * had been dropped and a different one had refused the row.
   */
  async function refusalFrom(statement: Promise<unknown>): Promise<string> {
    try {
      await statement;
    } catch (err) {
      const e = err as { message?: string; constraint_name?: string };
      return `${e.constraint_name ?? ''} ${e.message ?? String(err)}`;
    }
    throw new Error('the database accepted a row it was supposed to refuse');
  }

  async function versionOf(runId: string): Promise<string | null> {
    const rows = await db.execute<{ release_version: string | null }>(
      sql`SELECT release_version FROM pipeline_runs WHERE id = ${runId}`,
    );
    return rows[0]?.release_version ?? null;
  }

  describe('the database is what refuses a second release wearing one version', () => {
    it('refuses the duplicate by the name of the index that exists to refuse it', async () => {
      const first = await cutRelease();
      const second = await cutRelease();
      expect([first.version, second.version]).toEqual(['0.1.0', '0.2.0']);

      // Plant exactly what the rule forbids: the second release reaching for the first's number.
      const refusal = await refusalFrom(
        harness.client`UPDATE pipeline_runs SET release_version = ${first.version} WHERE id = ${second.runId}`,
      );
      expect(refusal).toMatch(/pipeline_runs_release_version_uq/);

      expect(await versionOf(second.runId)).toBe('0.2.0');
    });

    it('lets two PROJECTS wear the same number, because identity is per project', async () => {
      const mine = await cutRelease();
      const theirs = await cutRelease(() => otherProjectId);
      expect(mine.version).toBe('0.1.0');
      expect(theirs.version).toBe('0.1.0');
    });

    it('leaves every run that is not a release free of the index', async () => {
      // Two runs that are not releases, both NULL on the column. A unique index that was not
      // partial would refuse the second of them as a duplicate NULL under some engines, and would
      // in any case make every non-release run a candidate for a constraint that has nothing to
      // say about it. `pm` rather than `issue` because an `issue` run without an issue is itself
      // refused, by `pipeline_runs_issue_kind_chk`.
      for (const _ of [0, 1]) {
        await db.execute(sql`
          INSERT INTO pipeline_runs (project_id, kind, status, metadata)
          VALUES (${projectId}, 'pm', 'running', '{}'::jsonb)
        `);
      }
      const rows = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pipeline_runs WHERE project_id = ${projectId}`,
      );
      expect(rows[0]?.n).toBe(2);
    });
  });

  describe('the database is what refuses a version that is not three integers', () => {
    it.each([['0.1'], ['v0.1.0'], ['0.1.0-rc1'], ['0.1.0.1'], ['latest'], ['']])(
      'refuses %j by the name of the CHECK',
      async (bad) => {
        const { runId } = await cutRelease();
        const refusal = await refusalFrom(
          harness.client`UPDATE pipeline_runs SET release_version = ${bad} WHERE id = ${runId}`,
        );
        expect(refusal).toMatch(/pipeline_runs_release_version_chk/);
      },
    );

    it('keeps the digit ordering the cut depends on correct past ten', async () => {
      // '0.10.0' < '0.9.0' as text. If the cut ordered lexically it would read 0.9.0 as highest
      // here and hand out 0.10.0 a second time, which the unique index would then refuse.
      const runs = [];
      for (let i = 0; i < 11; i++) runs.push(await cutRelease());
      expect(runs.map((r) => r.version).slice(8)).toEqual(['0.9.0', '0.10.0', '0.11.0']);
    });
  });

  describe('a failed release burns its number', () => {
    it('keeps the version on the failed release row', async () => {
      const failed = await cutRelease();
      await setRunStatus(failed.runId, 'cancelled');
      expect(await versionOf(failed.runId)).toBe('0.1.0');
    });

    it('does not hand the burned number to the next release', async () => {
      const failed = await cutRelease();
      await setRunStatus(failed.runId, 'cancelled');

      const next = await cutRelease();
      expect(next.version).toBe('0.2.0');
      expect(next.version).not.toBe(failed.version);
    });

    it('leaves a gap in the sequence rather than closing it', async () => {
      const burned: string[] = [];
      for (let i = 0; i < 3; i++) {
        const run = await cutRelease();
        await setRunStatus(run.runId, 'cancelled');
        burned.push(run.version);
      }
      const survivor = await cutRelease();
      expect(burned).toEqual(['0.1.0', '0.2.0', '0.3.0']);
      expect(survivor.version).toBe('0.4.0');
    });

    it('burns the re-cut too, so a second failure does not hand back the first patch', async () => {
      const failed = await cutRelease();
      await setRunStatus(failed.runId, 'cancelled');

      const recut = await cutRelease(() => projectId, '0.1.0');
      expect(recut.version).toBe('0.1.1');
      await setRunStatus(recut.runId, 'cancelled');

      const again = await cutRelease(() => projectId, '0.1.1');
      expect(again.version).toBe('0.1.2');

      const rows = await db.execute<{ release_version: string }>(sql`
        SELECT release_version FROM pipeline_runs
        WHERE project_id = ${projectId} AND release_version IS NOT NULL
        ORDER BY string_to_array(release_version, '.')::int[] ASC
      `);
      expect(rows.map((r) => r.release_version)).toEqual(['0.1.0', '0.1.1', '0.1.2']);
    });
  });

  describe('a re-cut is refused unless the release it names actually failed', () => {
    it('refuses a release that is still running, naming its status', async () => {
      const open = await cutRelease();
      await expect(cutRelease(() => projectId, open.version)).rejects.toThrow(
        /is still running/,
      );
    });

    it('refuses a release that shipped, which its status no longer shows', async () => {
      const shipped = await cutRelease();
      await setRunStatus(shipped.runId, 'completed');
      await markReleaseShipped(shipped.runId);
      // Exactly what `cancelConcludedRun` leaves behind: a shipped release reading `cancelled`.
      await setRunStatus(shipped.runId, 'cancelled');

      await expect(cutRelease(() => projectId, shipped.version)).rejects.toThrow(
        ReleaseRecutRefusedError,
      );
      await expect(cutRelease(() => projectId, shipped.version)).rejects.toThrow(/SHIPPED/);
    });

    it('refuses a version that is not the highest, naming the one that is', async () => {
      const older = await cutRelease();
      await setRunStatus(older.runId, 'cancelled');
      const newer = await cutRelease();
      await setRunStatus(newer.runId, 'cancelled');

      await expect(cutRelease(() => projectId, older.version)).rejects.toThrow(
        /highest release is 0\.2\.0/,
      );
    });
  });

  describe('what the project is serving', () => {
    it('is nothing until a release ships, even with releases cut', async () => {
      await cutRelease();
      expect(await currentReleaseVersion(projectId)).toBeNull();
    });

    it('is the version of the last release that shipped', async () => {
      const first = await cutRelease();
      await setRunStatus(first.runId, 'completed');
      await markReleaseShipped(first.runId);
      expect(await currentReleaseVersion(projectId)).toBe('0.1.0');

      const second = await cutRelease();
      await setRunStatus(second.runId, 'completed');
      await markReleaseShipped(second.runId);
      expect(await currentReleaseVersion(projectId)).toBe('0.2.0');
    });

    it('is not moved by a release that was cut and failed afterwards', async () => {
      const shipped = await cutRelease();
      await setRunStatus(shipped.runId, 'completed');
      await markReleaseShipped(shipped.runId);

      const failed = await cutRelease();
      await setRunStatus(failed.runId, 'cancelled');

      expect(await currentReleaseVersion(projectId)).toBe('0.1.0');
    });

    it('does not change when the shipped release is aborted afterwards', async () => {
      const shipped = await cutRelease();
      await setRunStatus(shipped.runId, 'completed');
      await markReleaseShipped(shipped.runId);
      expect(await currentReleaseVersion(projectId)).toBe('0.1.0');

      // `cancelConcludedRun`'s flip, byte for byte: status goes to `cancelled` and the deployed
      // bytes do not come down. Read the status instead of the stamp and this answers null.
      await db.execute(sql`
        UPDATE pipeline_runs
        SET status = 'cancelled',
            metadata = coalesce(metadata, '{}'::jsonb) || '{"cancelledFrom":"completed"}'::jsonb
        WHERE id = ${shipped.runId}
      `);

      expect(await currentReleaseVersion(projectId)).toBe('0.1.0');
    });

    it('does not read another project’s releases', async () => {
      const mine = await cutRelease();
      await setRunStatus(mine.runId, 'completed');
      await markReleaseShipped(mine.runId);

      expect(await currentReleaseVersion(otherProjectId)).toBeNull();
    });
  });

  describe('the ship stamp', () => {
    it('does not move when a finish is replayed', async () => {
      const shipped = await cutRelease();
      await markReleaseShipped(shipped.runId);
      const rows = await db.execute<{ release_released_at: Date }>(
        sql`SELECT release_released_at FROM pipeline_runs WHERE id = ${shipped.runId}`,
      );
      const first = rows[0]?.release_released_at;

      await markReleaseShipped(shipped.runId);
      const again = await db.execute<{ release_released_at: Date }>(
        sql`SELECT release_released_at FROM pipeline_runs WHERE id = ${shipped.runId}`,
      );
      expect(again[0]?.release_released_at).toEqual(first);
    });

    it('is refused a run that never cut a version', async () => {
      const rows = await db.execute<{ id: string }>(sql`
        INSERT INTO pipeline_runs (project_id, kind, status, metadata)
        VALUES (${projectId}, 'system', 'running', ${JSON.stringify({ source: 'release-batch' })}::jsonb)
        RETURNING id
      `);
      const runId = rows[0]?.id as string;
      await markReleaseShipped(runId);

      const after = await db.execute<{ release_released_at: Date | null }>(
        sql`SELECT release_released_at FROM pipeline_runs WHERE id = ${runId}`,
      );
      expect(after[0]?.release_released_at).toBeNull();
    });
  });
  /**
   * The real path, end to end: `createReleaseBatch` cuts the number and `finishReleaseBatch` is
   * what refuses a release that has none and what stamps the ship. Everything above this exercises
   * the store; this exercises the two callers that are the whole point of it.
   */
  describe('the release path itself', () => {
    beforeEach(async () => {
      await fx.declareProduction();
      await fx.seedReleaseRunner();
    });

    async function nullTheVersion(runId: string): Promise<void> {
      await db.execute(sql`UPDATE pipeline_runs SET release_version = NULL WHERE id = ${runId}`);
    }

    it('cuts the version as the release is created, and reports it', async () => {
      const issue = await fx.insertIssue();
      const created = await fx.claim([issue]);

      expect(created.version).toBe('0.1.0');
      expect(await versionOf(created.runId)).toBe('0.1.0');
    });

    it('leaves no release row without a version, even on the very first release', async () => {
      await fx.claim([await fx.insertIssue()]);
      const rows = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pipeline_runs
        WHERE project_id = ${projectId}
          AND (metadata->>'source') = 'release-batch'
          AND release_version IS NULL
      `);
      expect(rows[0]?.n).toBe(0);
    });

    it('reports the version on the run\u2019s own state', async () => {
      const { runId } = await fx.claim([await fx.insertIssue()]);
      const { readReleaseRunState } = await import('../../src/release-batch/state.js');
      expect((await readReleaseRunState(runId))?.version).toBe('0.1.0');
    });

    it('refuses to finish a release row carrying no version, by name', async () => {
      const issue = await fx.insertIssue();
      const { runId } = await fx.claim([issue]);
      // Plant exactly the state the rule exists to refuse.
      await nullTheVersion(runId);

      const { finishReleaseBatch, ReleaseVersionMissingError } = await import(
        '../../src/release-batch/service.js'
      );
      await expect(
        finishReleaseBatch(runId, { type: 'user', id: ownerId }),
      ).rejects.toBeInstanceOf(ReleaseVersionMissingError);

      // And it refused BEFORE closing anything, which is what makes the refusal worth having.
      expect((await fx.stored(issue)).status).toBe('releasing');
    });

    it('stamps the ship on finish, so the project reports what it is serving', async () => {
      const { runId } = await fx.claim([await fx.insertIssue()]);
      const { finishReleaseBatch } = await import('../../src/release-batch/service.js');

      expect(await currentReleaseVersion(projectId)).toBeNull();
      await finishReleaseBatch(runId, { type: 'user', id: ownerId });
      expect(await currentReleaseVersion(projectId)).toBe('0.1.0');
    });

    it('keeps reporting it after the shipped release is aborted', async () => {
      const { runId } = await fx.claim([await fx.insertIssue()]);
      const { abortReleaseBatch, finishReleaseBatch } = await import(
        '../../src/release-batch/service.js'
      );
      await finishReleaseBatch(runId, { type: 'user', id: ownerId });

      // `abortReleaseBatch` on a completed run goes through `cancelConcludedRun`, which flips the
      // status to `cancelled` and takes nothing off the deploy. Read the status and this answers
      // null; read the stamp and it answers what is live.
      await abortReleaseBatch(runId, 'aborted after the fact', ownerId);
      expect(await fx.runStatus(runId)).toBe('cancelled');
      expect(await currentReleaseVersion(projectId)).toBe('0.1.0');
    });

    it('does not hand the next release the number a failed one burned', async () => {
      const first = await fx.claim([await fx.insertIssue()]);
      const { abortReleaseBatch } = await import('../../src/release-batch/service.js');
      await abortReleaseBatch(first.runId, 'the deploy did not come up', ownerId);

      const second = await fx.claim([await fx.insertIssue()]);
      expect(first.version).toBe('0.1.0');
      expect(second.version).toBe('0.2.0');
      expect(await versionOf(first.runId)).toBe('0.1.0');
    });
  });
});
