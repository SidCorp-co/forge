/**
 * `releasing` is a status a batch can DIE inside.
 *
 * `finishReleaseBatch` and `abortReleaseBatch` are the only writers that leave
 * it. Every other way a batch run can end — a failed release job, an operator
 * cancelling the run, `reapOrphanedOneShotRuns`, a claim that never got a job —
 * cleared `issues.release_batch_run_id` and said nothing about the status,
 * which was harmless while the issue stood at the `released` gate. With a
 * middle status it strands the row, and the claim column that could have found
 * it again is already gone: the shape `approved` has on sidpeak, where five
 * issues sit with no machine exit.
 *
 * Integration rather than unit because the rescue is a transition against real
 * constraints, and because the mocked twin of the sibling rule passed while the
 * real one was wrong.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

describe('release batch recovery E2E', () => {
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

  const fx = releaseBatchFixture(
    () => harness,
    () => ({ projectId, ownerId }),
  );
  const { declareProduction, seedReleaseRunner, insertIssue, stored, claim, waitFor } = fx;

  // cm:guard both cases must assert the STATUS and not only the cleared claim — clearing the claim is what the old code already did correctly, so a case that checks only that passes against the bug it was written for.
  describe('a release batch that ends without an outcome', () => {
    beforeEach(async () => {
      await declareProduction();
      await seedReleaseRunner();
    });

    it('rescues its issues from `releasing` when the run dies with neither finish nor abort', async () => {
      const { registerReleaseBatchClaimSubscriber } = await import(
        '../../src/release-batch/claim-subscriber.js'
      );
      const { HooksBus } = await import('../../src/pipeline/hooks.js');
      const a = await insertIssue();
      const b = await insertIssue();
      const { runId } = await claim([a, b]);
      expect((await stored(a)).status).toBe('releasing');

      const bus = new HooksBus();
      registerReleaseBatchClaimSubscriber(bus);
      bus.emit('pipelineRunStatusChanged', {
        runId,
        projectId,
        issueId: null,
        kind: 'system',
        fromStatus: 'running',
        toStatus: 'failed',
        currentStep: null,
      });
      await waitFor(async () => (await stored(a)).claim === null);

      for (const id of [a, b]) {
        const after = await stored(id);
        expect(after.status).toBe('reopen');
        expect(after.claim).toBeNull();
        // cm:guard NOT closed and NOT stamped: a release that died half-way has shipped nothing anyone verified, and a stamp here would unblock every `blocks` dependent as if it had
        expect(after.mergedAt).toBeNull();
      }
    });

    it('rescues the whole roster when a second batch was already in flight, so the claim never got a job', async () => {
      const { createReleaseBatch, BatchInFlightError } = await import(
        '../../src/release-batch/service.js'
      );
      const a = await insertIssue();
      const b = await insertIssue();
      await claim([a]);

      await expect(
        createReleaseBatch({ projectId, issueIds: [b], userId: ownerId }),
      ).rejects.toBeInstanceOf(BatchInFlightError);

      // cm:guard the SECOND batch's issue is the one under test: `createReleaseBatch` moves every claimed issue to `releasing` BEFORE it enqueues, so the conflict throws with the roster already mid-release and a bare claim-clear would leave it there under a run that never ran
      const after = await stored(b);
      expect(after.status).toBe('reopen');
      expect(after.claim).toBeNull();
      expect(after.mergedAt).toBeNull();
    });
  });
});
