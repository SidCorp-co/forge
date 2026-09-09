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
 * These cases go through `createReleaseBatch` rather than writing the claim by
 * hand: the claim is a CAS `UPDATE` in that function, and a test that re-issues
 * it proves its own SQL, not the batch's.
 *
 * Integration rather than unit because `check-flow-coverage.mjs` counts only
 * this suite as authoritative, and because the sibling rule's first version
 * passed the mocked suite and was falsified here.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const RELEASE_LABEL = 'release-box';
const SKIP_NOTE = { section: 'Skip', userFacing: '-' };

describe('release batch finish E2E', () => {
  let harness: TestDatabase;
  let projectId: string;
  let ownerId: string;
  let seq = 0;

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

  // cm:edge contract -> packages/core/src/release-batch/gate.ts — `resolveProductionDeclaration` reads exactly a production branch distinct from the base plus an active `prod` binding; seed one half and every case here dies on NO_RELEASE_GATE before reaching what it asserts
  async function declareProduction(config: Record<string, unknown> = {}): Promise<void> {
    const connectionId = randomUUID();
    await harness.db.execute(sql`
      UPDATE projects SET base_branch = 'main', production_branch = 'production'
      WHERE id = ${projectId}
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
      VALUES (${connectionId}, 'user', ${ownerId}, 'coolify', true)
    `);
    await harness.db.execute(sql`
      INSERT INTO integration_bindings (connection_id, project_id, provider, environment, active, config)
      VALUES (
        ${connectionId}, ${projectId}, 'coolify', 'prod', true,
        ${JSON.stringify({ releaseRunnerLabel: RELEASE_LABEL, ...config })}::jsonb
      )
    `);
  }

  // cm:guard the box must carry the LABEL and be claim-capable, which are two different gates: `resolveReleaseDeviceIds` matches on `runners.labels`, and `onlineCapableDeviceIds` then asks whether anyone in that set is alive and above the version floor. Seed the label without the liveness and the batch refuses NO_RUNNER_ONLINE, which reads nothing like the pool being empty.
  async function seedReleaseRunner(): Promise<void> {
    const device = await createTestDevice(harness.db, ownerId, { status: 'online' });
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
      VALUES (
        ${randomUUID()}, ${projectId}, 'claude-code', ${device.id}, 'release-runner',
        'online', now(), ${JSON.stringify([RELEASE_LABEL])}::jsonb
      )
    `);
  }

  async function insertIssue(status = 'released', note: unknown = SKIP_NOTE): Promise<string> {
    const id = randomUUID();
    seq += 1;
    await harness.db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
      VALUES (
        ${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId},
        ${note === null ? null : JSON.stringify(note)}::jsonb
      )
    `);
    return id;
  }

  async function stored(id: string): Promise<{
    status: string;
    mergedAt: unknown;
    claim: unknown;
  }> {
    const rows = await harness.db.execute(sql`
      SELECT status, merged_at, release_batch_run_id FROM issues WHERE id = ${id}
    `);
    return {
      status: String(rows[0]?.status),
      mergedAt: rows[0]?.merged_at ?? null,
      claim: rows[0]?.release_batch_run_id ?? null,
    };
  }

  async function runStatus(runId: string): Promise<string> {
    const rows = await harness.db.execute(sql`
      SELECT status FROM pipeline_runs WHERE id = ${runId}
    `);
    return String(rows[0]?.status);
  }

  async function commentCount(issueId: string): Promise<number> {
    const rows = await harness.db.execute(sql`
      SELECT count(*)::int AS n FROM comments WHERE issue_id = ${issueId}
    `);
    return Number(rows[0]?.n ?? 0);
  }

  async function claim(ids: string[]) {
    const { createReleaseBatch } = await import('../../src/release-batch/service.js');
    return createReleaseBatch({ projectId, issueIds: ids, userId: ownerId });
  }

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
        // cm:guard this asserts the OUTCOME, never a writer: `released -> closed` is a hop that BOTH `markMergedIfLeavingBase` and `markMergedOnClose` stamp on, and disabling either one alone leaves this green (measured while mutating it). Which writer fired is settled in `src/issues/merged-at.test.ts`; what this defends is that a finish never closes an issue whose `blocks` dependents stay wedged.
        expect(after.mergedAt).not.toBeNull();
      }
    });

    // cm:guard the claim and the STATUS move together, and this asserts the status because the column alone was the whole defect: before `releasing` existed an issue stood at the gate status for the length of its batch, so `released` meant both "waiting for a person to press it" and "being released right now" and no reader could separate them.
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

    // cm:guard an aborted release must be DISTINGUISHABLE from one never attempted. The abort used to clear the claim and leave the status alone, so a failed release and an untouched issue read identically; `reopen` is where a person decides, and it does not self-heal on purpose.
    it('lands an aborted batch on `reopen` with the reason, not back where it started', async () => {
      const { abortReleaseBatch } = await import('../../src/release-batch/service.js');
      const a = await insertIssue();
      const { runId } = await claim([a]);
      expect((await stored(a)).status).toBe('releasing');

      const touched = await abortReleaseBatch(runId, 'deploy never reported', ownerId);

      expect(touched).toEqual([a]);
      const after = await stored(a);
      expect(after.status).toBe('reopen');
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

    // cm:guard the refusal must close NOTHING, not merely report a failure: a partial close leaves some issues claiming a release the probes just said did not happen, and nothing walks that back
    it('refuses the whole batch when the probes cannot confirm the deploy, and closes nothing', async () => {
      await truncateAll(harness.db);
      const owner = await createTestUser(harness.db);
      ownerId = owner.id;
      projectId = (await createTestProject(harness.db, owner.id)).id;
      // cm:why timeoutSeconds 0 makes `verifyDeployed`'s poll loop exit before its first read, so the case asserts the refusal rather than spending five minutes reaching it
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
      for (const id of [a, b]) {
        const after = await stored(id);
        // cm:guard `releasing` and NOT the gate status: a refused verification leaves the batch IN FLIGHT — the claim is still held and `finish` may be retried — so the status must keep saying so. Asserting the gate status here would pass equally if the claim had been silently rolled back.
        expect(after.status).toBe('releasing');
        expect(after.mergedAt).toBeNull();
        expect(after.claim).toBe(runId);
      }
    });

    // cm:guard a NO_OP is the retry case — `finish` running twice, or after an issue was closed by hand — and it must count as closed. Reporting it under `failed` would make a successful release look half-failed and invite an operator to re-run it.
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

      expect(released.sort()).toEqual([a, b].sort());
      for (const id of [a, b]) {
        const after = await stored(id);
        // cm:guard `reopen`, not the gate status: this assertion read `released` until the release lane gained `releasing`, and asserting the gate status here is what made a failed release indistinguishable from one never attempted. Nothing may close — that is what the `mergedAt` check below is for.
        expect(after.status).toBe('reopen');
        expect(after.claim).toBeNull();
        expect(after.mergedAt).toBeNull();
        // cm:guard TWO comments, and both are load-bearing: the abort's own explanation, and the reason `requiresAuthoredReason` posts before the `reopen` write commits. A test asserting one would be satisfied by an abort that moved the status with no reason on the record — the unexplained park the reason rule exists to refuse.
        expect(await commentCount(id)).toBe(2);
      }
    });

    // cm:guard abort means "nothing under this run executes any further", not just "no claims": batch ee39c4ae (2026-09-03) was aborted while its retry job kept running and shipped 20 commits to production. The run going terminal is what makes the cascade cancel the queued retries.
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
