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
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { releaseBatchFixture } from '../helpers/release-batch-fixture.js';

let harness: TestDatabase;
let projectId: string;
let ownerId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  // ISS-1071 — what src/index.ts does at boot. This file builds the app from its own
  // modules rather than from that file, and a registry-backed path reads the registry
  // EMPTY, which throws rather than answering "no providers are declared".
  (await import('../../src/integrations/register-all.js')).registerAllIntegrations();
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
async function abort(runId: string, reason: string) {
  const { abortReleaseBatch } = await import('../../src/release-batch/service.js');
  return abortReleaseBatch(runId, reason, ownerId);
}

async function recordPromotion(runId: string): Promise<void> {
  const { openAttempt } = await import('../../src/release-batch/ledger.js');
  await openAttempt({ runId, stage: 'promote', idempotencyKey: 'promote-1', commit: 'abc' });
}

// cm:guard the gated project is seeded ONCE, at file scope, and every group below inherits it:
// `resolveProductionDeclaration` needs both halves or each case dies on NO_RELEASE_GATE before
// reaching what it asserts, and four copies of that seeding is four places it can drift.
beforeEach(async () => {
  await declareProduction();
  await seedReleaseRunner();
});

// cm:guard both cases must assert the STATUS and not only the cleared claim — clearing the claim is what the old code already did correctly, so a case that checks only that passes against the bug it was written for.
describe('a release batch that ends without an outcome', () => {
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
      // cm:guard the project's own gate status and no longer `reopen` (ISS-1042). This run
      // recorded no promotion, so the issue is still merged, still verified and still waiting for
      // production — which is what the gate status means. `reopen` said it had come back from a
      // release that never happened.
      expect(after.status).toBe('awaiting_release');
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
    expect(after.status).toBe('awaiting_release');
    expect(after.claim).toBeNull();
    expect(after.mergedAt).toBeNull();
  });
});

// cm:guard criteria 30 to 32. The destination is chosen by what the run RECORDED and by nothing
// else — not by which verb called, not by the run's status. `reopen` for everything was wrong in
// both directions: over a batch that never promoted it said the issue had come back from a
// release that did not happen, and over one that DID promote it said there was work to redo on
// code that is serving production right now.
describe('where an unfinished batch leaves its roster', () => {
  it('returns a roster that never promoted to the status the release gate gives', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);

    const result = await abort(runId, 'the deploy never landed');

    expect(result).toMatchObject({ destination: 'awaiting_release', promoted: false });
    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
  });

  // cm:guard the CLAIM has to survive alongside the status. `release_batch_run_id` is the only
  // index onto these rows, so an issue left at `releasing` with the claim cleared is unreachable
  // by every reader there is — which is a worse strand than the one this whole module removes.
  it('leaves a roster that promoted at `releasing`, still claimed', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await recordPromotion(runId);

    const result = await abort(runId, 'the deploy half landed');

    expect(result).toMatchObject({ promoted: true, destination: null, claimsCleared: [] });
    expect(await stored(a)).toMatchObject({ status: 'releasing', claim: runId });
  });

  // cm:guard a roster nothing moved must not go SILENT. A batch left at `releasing` with nothing
  // written on it reads as a release still running, which is the state ISS-923 measured 98 times
  // across 18 projects; the comment is the only thing that makes it findable.
  it('says on each issue why it was left where it is', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await recordPromotion(runId);

    await abort(runId, 'the deploy half landed');

    expect(await commentCount(a)).toBe(1);
  });

  // cm:guard criterion 32 — the SWEEP path, not the abort. `recoverStrandedReleasing` is the one
  // writer of a roster leaving `releasing` without an outcome, and a promotion rule that held
  // only for the verb would be walked straight past by the machine that arrives later.
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

  // cm:guard an attempt that was DECLARED and never reported back still counts as a promotion.
  // It is exactly the act that may have landed, and reading an unsettled promote as "nothing
  // happened" walks a roster back over code that is serving.
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

  // cm:guard a non-promote attempt is NOT a promotion. Without this the rule degrades to "the run
  // did something", and every batch that got as far as one deploy would strand its roster.
  it('does not read a deploy attempt as a promotion', async () => {
    const { openAttempt } = await import('../../src/release-batch/ledger.js');
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await openAttempt({ runId, stage: 'deploy', idempotencyKey: 'deploy-1' });

    await abort(runId, 'the deploy never landed');

    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
  });
});

// cm:guard criteria 33 and 34. `closeRunIfOneShot` matches `running|paused` only, so an abort
// arriving on a run something already concluded wrote nothing and SAID nothing: the row went on
// reading `completed` about a batch somebody had called off, and the caller was handed a plain
// success. Routed here from ISS-1032 because this issue owns "a release run cannot lie".
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

  // cm:guard the PREVIOUS outcome is the whole point of recording it: whatever that success
  // closed is still closed, and an operator reading the abort has no other way to learn that this
  // run had already reported one.
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

  // cm:guard the ordinary abort must report the OTHER answer, or `wasAlreadyTerminal` is a field
  // that is always true and says nothing.
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

  // cm:guard re-aborting must not rewrite `finished_at` or file a second audit row for a flip
  // that already happened; the predicate excludes `cancelled` for exactly that.
  it('does not flip a run that is already cancelled a second time', async () => {
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await abort(runId, 'the deploy never landed');

    const second = await abort(runId, 'aborted again by mistake');

    expect(second.run.wasAlreadyTerminal).toBe(false);
    expect(await runStatus(runId)).toBe('cancelled');
  });
});
