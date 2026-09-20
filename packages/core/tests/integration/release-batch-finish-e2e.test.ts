/**
 * The release path's close, against real Postgres.
 *
 * `finishReleaseBatch` was executed by no test at all (ISS-863) — which is why
 * nothing noticed when the pre-ISS-897 version of it closed claimed issues
 * without their release ever running. It is also the ONLY caller entitled to
 * pass `viaReleasePath`, the flag that exempts a close from the release-record
 * refusal, so what it does with a claim is the last thing standing between an
 * issue and a `closed` nobody wrote anything about.
 *
 * The seeding lives in `tests/helpers/release-batch-fixture.ts`, shared with
 * the recovery suite next door.
 *
 * Integration rather than unit because `check-flow-coverage.mjs` counts only
 * this suite as authoritative, and because the sibling rule's first version
 * passed the mocked suite and was falsified here.
 */

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
import { releaseBatchFixture, SKIP_NOTE } from '../helpers/release-batch-fixture.js';

describe('release batch finish E2E', () => {
  let harness: TestDatabase;
  let projectId: string;
  let ownerId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.NODE_ENV ??= 'test';
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    await registerIntegrationsForTest();
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

  const fx = releaseBatchFixture(
    () => harness,
    () => ({ projectId, ownerId }),
  );
  const { declareProduction, seedReleaseRunner, insertIssue, stored } = fx;
  const { runStatus, commentCount, claim } = fx;

  const actor = () => ({ type: 'user', id: ownerId }) as const;

  describe('finish', () => {
    beforeEach(async () => {
      await declareProduction();
      await seedReleaseRunner();
    });

    it('closes every claimed issue out of the gate status, on the claim it already carried', async () => {
      const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
      const a = await insertIssue();
      const b = await insertIssue();
      const before = await Promise.all([stored(a), stored(b)]);
      const { runId } = await claim([a, b]);

      const result = await finishReleaseBatch(runId, actor());

      expect(result.closed.sort()).toEqual([a, b].sort());
      expect(result.failed).toEqual([]);
      for (const [i, id] of [a, b].entries()) {
        const after = await stored(id);
        expect(after.status).toBe('closed');
        // ISS-1108 — the close writes no stamp of its own, so the claim is the
        // one the merge mark made, to the microsecond.
        expect(after.mergedAt).toEqual(before[i]?.mergedAt);
      }
    });

    it('refuses to close a roster issue that cannot show it shipped, and names it', async () => {
      const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
      const unshipped = await insertIssue('awaiting_release', SKIP_NOTE, false);
      const { runId } = await claim([unshipped]);

      const result = await finishReleaseBatch(runId, actor());

      expect(result.closed).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.id).toBe(unshipped);
      expect(result.failed[0]?.reason).toContain('CLOSE_REQUIRES_SHIPPED');
      expect((await stored(unshipped)).status).not.toBe('closed');
    });

    it('marks every claimed issue `releasing`, so a batch in flight is readable from the status', async () => {
      const a = await insertIssue();
      const b = await insertIssue();

      const { runId } = await claim([a, b]);

      for (const id of [a, b]) {
        const after = await stored(id);
        expect(after.status).toBe('releasing');
        expect(after.claim).toBe(runId);
      }
    });

    it('returns an aborted batch that never promoted to the project’s release gate', async () => {
      const { abortReleaseBatch } = await import('../../src/release-batch/service.js');
      const a = await insertIssue();
      const before = await stored(a);
      const { runId } = await claim([a]);
      expect((await stored(a)).status).toBe('releasing');

      const touched = await abortReleaseBatch(runId, 'deploy never reported', ownerId);

      expect(touched).toMatchObject({
        claimsCleared: [a],
        destination: 'awaiting_release',
        promoted: false,
      });
      const after = await stored(a);
      expect(after.status).toBe('awaiting_release');
      expect(after.claim).toBeNull();
      // ISS-1108 — the stamp is the merge mark's and no longer says anything about
      // whether this batch closed anything; the STATUS above is what says that. What
      // is still worth pinning is that an abort neither writes one nor clears one.
      expect(after.mergedAt).toEqual(before.mergedAt);
    });

    it('releases the claim on every issue it touched', async () => {
      const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
      const a = await insertIssue();
      const { runId } = await claim([a]);
      expect((await stored(a)).claim).toBe(runId);

      await finishReleaseBatch(runId, actor());

      expect((await stored(a)).claim).toBeNull();
    });

    it('refuses the whole batch when the probes cannot confirm the deploy, and closes nothing', async () => {
      await truncateAll(harness.db);
      const owner = await createTestUser(harness.db);
      ownerId = owner.id;
      projectId = (await createTestProject(harness.db, owner.id)).id;
      await declareProduction({
        verify: { probes: [{ url: 'http://127.0.0.1:9/never' }], timeoutSeconds: 0 },
      });
      await seedReleaseRunner();
      const { ReleaseNotVerifiedError, finishReleaseBatch } = await import(
        '../../src/release-batch/service.js'
      );
      const a = await insertIssue();
      // One carries the claim and one does not: a refused finish must leave both
      // exactly as it found them.
      const b = await insertIssue('awaiting_release', SKIP_NOTE, false);
      const before = new Map([
        [a, (await stored(a)).mergedAt],
        [b, (await stored(b)).mergedAt],
      ]);
      expect(before.get(b)).toBeNull();
      const { runId } = await claim([a, b]);

      const err = await finishReleaseBatch(runId, actor()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ReleaseNotVerifiedError);
      expect(await runStatus(runId)).toBe('running');
      for (const id of [a, b]) {
        const after = await stored(id);
        expect(after.status).toBe('releasing');
        expect(after.mergedAt).toEqual(before.get(id));
        expect(after.claim).toBe(runId);
      }
    });

    it('counts an already-closed claimed issue as closed rather than as failed', async () => {
      const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
      const a = await insertIssue();
      const { runId } = await claim([a]);
      await harness.db.execute(sql`
        UPDATE issues SET status = 'closed', merged_at = COALESCE(merged_at, now()) WHERE id = ${a}
      `);

      const result = await finishReleaseBatch(runId, actor());

      expect(result.closed).toEqual([a]);
      expect(result.failed).toEqual([]);
    });
  });

  describe('abort', () => {
    beforeEach(async () => {
      await declareProduction();
      await seedReleaseRunner();
    });

    it('releases every claim, closes nothing, and comments once on each issue', async () => {
      const { abortReleaseBatch } = await import('../../src/release-batch/service.js');
      const a = await insertIssue();
      // One carries the claim and one does not, so an abort is shown to write no
      // stamp as well as to clear none.
      const b = await insertIssue('awaiting_release', SKIP_NOTE, false);
      const before = new Map([
        [a, (await stored(a)).mergedAt],
        [b, (await stored(b)).mergedAt],
      ]);
      expect(before.get(b)).toBeNull();
      const { runId } = await claim([a, b]);

      const released = await abortReleaseBatch(runId, 'the deploy never landed', ownerId);

      expect(released.claimsCleared.sort()).toEqual([a, b].sort());
      for (const id of [a, b]) {
        const after = await stored(id);
        expect(after.status).toBe('awaiting_release');
        expect(after.claim).toBeNull();
        expect(after.mergedAt).toEqual(before.get(id));
        expect(await commentCount(id)).toBe(1);
      }
    });

    it('takes the run terminal so the cascade can reap its jobs', async () => {
      const { abortReleaseBatch } = await import('../../src/release-batch/service.js');
      const a = await insertIssue();
      const { runId } = await claim([a]);
      expect(await runStatus(runId)).toBe('running');

      await abortReleaseBatch(runId, 'aborted by the operator', ownerId);

      expect(await runStatus(runId)).toBe('cancelled');
    });
  });
});
