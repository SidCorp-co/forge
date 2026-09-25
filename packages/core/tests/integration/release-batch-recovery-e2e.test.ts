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
const { declareProduction, seedReleaseRunner, insertIssue, stored, claim, waitFor } = fx;
const { runStatus, commentCount } = fx;

/**
 * Put a `promote` attempt on the run, as an agent does before it promotes.
 *
 * Through `openAttempt` and never a hand-written INSERT: what the recovery
 * reads is the row that function writes, and a fixture re-issuing the SQL
 * would prove its own INSERT rather than the ledger's.
 */
async function abort(
  runId: string,
  reason: string,
  options: { promotedRoster?: 'hold' | 'return-to-gate' } = {},
) {
  const { abortReleaseBatch } = await import('../../src/release-batch/service.js');
  return abortReleaseBatch(runId, reason, ownerId, options);
}

async function recordPromotion(runId: string): Promise<void> {
  const { openAttempt } = await import('../../src/release-batch/ledger.js');
  await openAttempt({ runId, stage: 'promote', idempotencyKey: 'promote-1', commit: 'abc' });
}

beforeEach(async () => {
  await declareProduction();
  await seedReleaseRunner();
});

describe('a release batch that ends without an outcome', () => {
  it('rescues its issues from `releasing` when the run dies with neither finish nor abort', async () => {
    const { registerReleaseBatchClaimSubscriber } = await import(
      '../../src/release-batch/claim-subscriber.js'
    );
    const { HooksBus } = await import('../../src/pipeline/hooks.js');
    const a = await insertIssue();
    // One roster issue carries the claim and one does not, so "neither writes a
    // stamp nor clears one" is proved in both directions rather than only where
    // there was already something to preserve.
    const b = await insertIssue('awaiting_release', SKIP_NOTE, false);
    const before = new Map([
      [a, (await stored(a)).mergedAt],
      [b, (await stored(b)).mergedAt],
    ]);
    expect(before.get(b)).toBeNull();
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
      expect(after.status).toBe('awaiting_release');
      expect(after.claim).toBeNull();
      // ISS-1108 — the stamp is the merge mark's and says nothing about whether a
      // batch closed anything; the STATUS above carries that. What is still worth
      // pinning is that a rescue neither writes a stamp nor clears one.
      expect(after.mergedAt).toEqual(before.get(id));
    }
  });

  it('rescues the whole roster when a second batch was already in flight, so the claim never got a job', async () => {
    const { createReleaseBatch, BatchInFlightError } = await import(
      '../../src/release-batch/service.js'
    );
    const a = await insertIssue();
    const b = await insertIssue();
    const before = (await stored(b)).mergedAt;
    await claim([a]);

    await expect(
      createReleaseBatch({ projectId, issueIds: [b], userId: ownerId }),
    ).rejects.toBeInstanceOf(BatchInFlightError);

    const after = await stored(b);
    expect(after.status).toBe('awaiting_release');
    expect(after.claim).toBeNull();
    expect(after.mergedAt).toEqual(before);
  });
});

describe('where an unfinished batch leaves its roster', () => {
  it('returns a roster that never promoted to the status the release gate gives', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);

    const result = await abort(runId, 'the deploy never landed');

    expect(result).toMatchObject({ destination: 'awaiting_release', promoted: false });
    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
  });

  it('leaves a roster that promoted at `releasing`, still claimed', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await recordPromotion(runId);

    const result = await abort(runId, 'the deploy half landed');

    expect(result).toMatchObject({ promoted: true, destination: null, claimsCleared: [] });
    expect(await stored(a)).toMatchObject({ status: 'releasing', claim: runId });
  });

  it('says on each issue why it was left where it is', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await recordPromotion(runId);

    await abort(runId, 'the deploy half landed');

    expect(await commentCount(a)).toBe(1);
  });

  it('leaves a promoted roster at `releasing` on a later stranded-releasing recovery too', async () => {
    const { recoverStrandedReleasing } = await import(
      '../../src/release-batch/releasing-recovery.js'
    );
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await recordPromotion(runId);

    const result = await recoverStrandedReleasing(runId, { reason: 'the batch died' });

    expect(result).toMatchObject({ promoted: true, recovered: [] });
    expect(await stored(a)).toMatchObject({ status: 'releasing', claim: runId });
  });

  it('counts a promotion whose act never reported back', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await recordPromotion(runId);

    const [row] = await harness.db.execute(
      sql`SELECT settled_at FROM release_attempts WHERE run_id = ${runId}`,
    );
    expect(row?.settled_at).toBeNull();
    await abort(runId, 'the agent was killed');
    expect((await stored(a)).status).toBe('releasing');
  });

  // ISS-1199 — holding is right by default and was the only thing on offer, so
  // a batch that promoted and could not verify had no door to terminal at all:
  // finish refused, abort held, and the roster kept its claim as well as its
  // status. Naming the settlement is a person's word that the code IS live and
  // the record should be made where evidence can be attached to it.
  it('returns a promoted roster to the gate where the operator names the settlement', async () => {
    const a = await insertIssue();
    const b = await insertIssue();
    const { runId } = await claim([a, b]);
    await recordPromotion(runId);

    const result = await abort(runId, 'this batch cannot verify', {
      promotedRoster: 'return-to-gate',
    });

    expect(result).toMatchObject({ promoted: true, destination: 'awaiting_release' });
    for (const id of [a, b]) {
      expect(await stored(id)).toMatchObject({ status: 'awaiting_release', claim: null });
    }
  });

  it('tells each returned issue that the promotion happened and where to record it', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await recordPromotion(runId);

    await abort(runId, 'this batch cannot verify', { promotedRoster: 'return-to-gate' });

    const rows = await harness.db.execute(sql`SELECT body FROM comments WHERE issue_id = ${a}`);
    const body = String(rows[0]?.body ?? '');
    expect(body).toContain('recorded a promotion');
    expect(body).toContain('release-records');
  });

  it('holds the roster where the settlement is named `hold`', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await recordPromotion(runId);

    const result = await abort(runId, 'the deploy half landed', { promotedRoster: 'hold' });

    expect(result).toMatchObject({ promoted: true, destination: null, claimsCleared: [] });
    expect(await stored(a)).toMatchObject({ status: 'releasing', claim: runId });
  });

  it('settles nothing extra on a run that never promoted', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);

    const result = await abort(runId, 'the deploy never landed', {
      promotedRoster: 'return-to-gate',
    });

    expect(result).toMatchObject({ promoted: false, destination: 'awaiting_release' });
    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
  });

  it('does not read a deploy attempt as a promotion', async () => {
    const { openAttempt } = await import('../../src/release-batch/ledger.js');
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await openAttempt({ runId, stage: 'deploy', idempotencyKey: 'deploy-1' });

    await abort(runId, 'the deploy never landed');

    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
  });
});

describe('an abort of a run something already concluded', () => {
  it('takes a `completed` run to `cancelled` and reports that it did', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await harness.db.execute(
      sql`UPDATE pipeline_runs SET status = 'completed' WHERE id = ${runId}`,
    );

    const result = await abort(runId, 'the deploy never landed');

    expect(result.run).toEqual({
      status: 'cancelled',
      wasAlreadyTerminal: true,
      cancelledFrom: 'completed',
    });
    expect(await runStatus(runId)).toBe('cancelled');
  });

  it('keeps what the run said before the flip, on the run itself', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await harness.db.execute(
      sql`UPDATE pipeline_runs SET status = 'completed' WHERE id = ${runId}`,
    );

    await abort(runId, 'the deploy never landed');

    const [row] = await harness.db.execute(
      sql`SELECT metadata FROM pipeline_runs WHERE id = ${runId}`,
    );
    expect(row?.metadata).toMatchObject({
      source: 'release-batch',
      cancelledFrom: 'completed',
    });
  });

  it('reports a live run as one the ordinary close already cancelled', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);

    const result = await abort(runId, 'the deploy never landed');

    expect(result.run).toEqual({
      status: 'cancelled',
      wasAlreadyTerminal: false,
      cancelledFrom: null,
    });
  });

  it('does not flip a run that is already cancelled a second time', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await abort(runId, 'the deploy never landed');

    const second = await abort(runId, 'aborted again by mistake');

    expect(second.run.wasAlreadyTerminal).toBe(false);
    expect(await runStatus(runId)).toBe('cancelled');
  });
});
