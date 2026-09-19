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
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

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

    it('closes every claimed issue out of the gate status and stamps merged_at', async () => {
      const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
      const a = await insertIssue();
      const b = await insertIssue();
      const { runId } = await claim([a, b]);

      const result = await finishReleaseBatch(runId, actor());

      expect(result.closed.sort()).toEqual([a, b].sort());
      expect(result.failed).toEqual([]);
      for (const id of [a, b]) {
        const after = await stored(id);
        expect(after.status).toBe('closed');
        expect(after.mergedAt).not.toBeNull();
      }
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
      expect(after.mergedAt).toBeNull();
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
      const b = await insertIssue();
      const { runId } = await claim([a, b]);

      const err = await finishReleaseBatch(runId, actor()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ReleaseNotVerifiedError);
      expect(await runStatus(runId)).toBe('running');
      for (const id of [a, b]) {
        const after = await stored(id);
        expect(after.status).toBe('releasing');
        expect(after.mergedAt).toBeNull();
        expect(after.claim).toBe(runId);
      }
    });

    it('counts an already-closed claimed issue as closed rather than as failed', async () => {
      const { finishReleaseBatch } = await import('../../src/release-batch/service.js');
      const a = await insertIssue();
      const { runId } = await claim([a]);
      await harness.db.execute(sql`
        UPDATE issues SET status = 'closed' WHERE id = ${a}
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
      const b = await insertIssue();
      const { runId } = await claim([a, b]);

      const released = await abortReleaseBatch(runId, 'the deploy never landed', ownerId);

      expect(released.claimsCleared.sort()).toEqual([a, b].sort());
      for (const id of [a, b]) {
        const after = await stored(id);
        expect(after.status).toBe('awaiting_release');
        expect(after.claim).toBeNull();
        expect(after.mergedAt).toBeNull();
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
