/**
 * ISS-1281 — a release whose owner is gone is said out loud: nobody took it before its deadline,
 * or the run session that took it ended before a finish was accepted.
 *
 * Integration, because the propositions are about guarded writes racing each other: whether a
 * loss the recovery pass declared makes a finish acceptance miss, whether a finish in hand makes
 * the loss miss, and which of two presses wins the advisory lock.
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
import { DRAINING, refusalOf, releaseOwnerProbes } from '../helpers/release-owner-probes.js';

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
  await fx.declareProduction();
});

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);
const { insertIssue, stored, claim, take, runStatus, seedReleaseRunner } = fx;

const { ownerOf, counts, endSession, wedgesFor, recover } = releaseOwnerProbes(() => harness);

describe('a release whose owner is gone', () => {
  it('hands the roster back, cancels the run and says why, when nobody took it in time', async () => {
    await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await harness.db.execute(sql`
      UPDATE pipeline_runs
         SET metadata = jsonb_set(metadata, '{owner,deadlineAt}', to_jsonb((now() - interval '1 minute')::text))
       WHERE id = ${runId}
    `);

    expect(await recover()).toEqual({ lost: [runId], orphaned: [] });

    expect(await runStatus(runId)).toBe('cancelled');
    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
    expect((await ownerOf(runId)).why).toMatch(/no master took this release/);
    expect(await wedgesFor(runId)).toEqual(['A release was cancelled because no master took it']);
    expect(await recover()).toEqual({ lost: [], orphaned: [] });
  });

  it('leaves a release still inside its deadline waiting', async () => {
    await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);

    expect(await recover()).toEqual({ lost: [], orphaned: [] });
    expect((await ownerOf(runId)).state).toBe('awaiting');
  });

  it('gives the roster back when the owning session ends before a finish', async () => {
    const box = await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);
    const opened = await take(runId, box.deviceId);
    await endSession(opened.sessionId);

    expect(await recover()).toEqual({ lost: [runId], orphaned: [] });

    expect(await stored(a)).toMatchObject({ status: 'awaiting_release', claim: null });
    expect(await wedgesFor(runId)).toEqual([
      'A release was cancelled because the run that owned it ended',
    ]);
  });

  it('holds the roster for a person where the run had already promoted', async () => {
    const box = await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);
    const opened = await take(runId, box.deviceId);
    const { openAttempt } = await import('../../src/release-batch/ledger.js');
    await openAttempt({ runId, stage: 'promote', idempotencyKey: 'promote-1', commit: 'abc' });
    await endSession(opened.sessionId);

    expect(await recover()).toEqual({ lost: [], orphaned: [runId] });

    expect(await runStatus(runId)).toBe('running');
    expect((await stored(a)).status).toBe('releasing');
    expect((await ownerOf(runId)).state).toBe('orphaned');
    expect(await wedgesFor(runId)).toEqual([
      'A release that had already promoted lost the run that owned it',
    ]);
  });

  it('declares nothing once the finish was accepted, even with the owner gone', async () => {
    const box = await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);
    const opened = await take(runId, box.deviceId);
    const { acceptReleaseBatchFinish } = await import('../../src/release-batch/finish-job.js');
    await acceptReleaseBatchFinish(runId, { type: 'user', id: ownerId }, {}, async () => {});
    await endSession(opened.sessionId);

    expect(await recover()).toEqual({ lost: [], orphaned: [] });
    expect((await ownerOf(runId)).state).toBe('owned');
  });

  it('refuses a finish once the loss is declared, before the roster is even handed back', async () => {
    const box = await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await take(runId, box.deviceId);
    // The loss pass's own guarded write, landing between a finish's read and its accept.
    await harness.db.execute(sql`
      UPDATE pipeline_runs
         SET metadata = jsonb_set(metadata, '{owner,state}', '"lost"'::jsonb)
       WHERE id = ${runId}
    `);
    const { acceptReleaseBatchFinish } = await import('../../src/release-batch/finish-job.js');

    const err = await refusalOf(
      acceptReleaseBatchFinish(runId, { type: 'user', id: ownerId }, {}, async () => {}),
    );

    expect(err.message).toMatch(/RELEASE_OWNER_LOST/);
    const rows = (await harness.db.execute(sql`
      SELECT metadata -> 'finish' AS finish FROM pipeline_runs WHERE id = ${runId}
    `)) as unknown as Array<{ finish: unknown }>;
    expect(rows[0]?.finish).toBeNull();
  });
});

// The window no pre-read can see: a take between another master's check and its commit.
describe('the guards inside the writes', () => {
  // The pre-check found the box able; by the time its open holds the release row it is not.
  it.each([
    [
      'began draining',
      'draining for update',
      async (deviceId: string) => {
        await harness.db.execute(sql`
        UPDATE devices SET capabilities = ${JSON.stringify(DRAINING)}::jsonb WHERE id = ${deviceId}
      `);
      },
    ],
    [
      'lost its master',
      'no master pane of this project is running there',
      async (deviceId: string) => {
        await harness.db.execute(sql`
        UPDATE agent_sessions SET status = 'completed' WHERE device_id = ${deviceId} AND kind = 'master'
      `);
      },
    ],
  ] as const)(
    'refuses, inside the open, a box that %s since its pre-check',
    async (_, clause, change) => {
      const box = await seedReleaseRunner();
      const a = await insertIssue();
      const { runId } = await claim([a]);
      await change(box.deviceId);
      const { takeReleaseOwnership } = await import('../../src/release-batch/owner-take.js');

      const err = await refusalOf(
        harness.db.transaction(async (tx) =>
          takeReleaseOwnership(tx as never, {
            releaseRunId: runId,
            deviceId: box.deviceId,
            deviceName: box.deviceName,
            sessionId: crypto.randomUUID(),
            runId: crypto.randomUUID(),
            preferenceMet: true,
          }),
        ),
      );

      expect(err.message).toContain(clause);
      expect((await ownerOf(runId)).state).toBe('awaiting');
    },
  );

  it('refuses, inside the open, a take of a release another session already owns', async () => {
    const box = await seedReleaseRunner();
    const other = await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);
    const opened = await take(runId, box.deviceId);
    const { takeReleaseOwnership } = await import('../../src/release-batch/owner-take.js');

    const err = await refusalOf(
      harness.db.transaction(async (tx) =>
        takeReleaseOwnership(tx as never, {
          releaseRunId: runId,
          deviceId: other.deviceId,
          deviceName: other.deviceName,
          sessionId: opened.sessionId,
          runId: opened.runId,
          preferenceMet: true,
        }),
      ),
    );

    expect(err.message).toContain(`already owned by run session ${opened.sessionId}`);
    expect((await ownerOf(runId)).deviceId).toBe(box.deviceId);
  });

  it('misses the finish record write once the owner is declared lost', async () => {
    const box = await seedReleaseRunner();
    const a = await insertIssue();
    const { runId } = await claim([a]);
    await take(runId, box.deviceId);
    const { acceptReleaseBatchFinish } = await import('../../src/release-batch/finish-job.js');
    await acceptReleaseBatchFinish(runId, { type: 'user', id: ownerId }, {}, async () => {});
    const { compareAndSet, readFinishRecord, stamp } = await import(
      '../../src/release-batch/finish-record.js'
    );
    const read = async () => {
      const rows = (await harness.db.execute(sql`
        SELECT metadata FROM pipeline_runs WHERE id = ${runId}
      `)) as unknown as Array<{ metadata: unknown }>;
      const record = readFinishRecord(rows[0]?.metadata);
      if (!record) throw new Error('no finish record was accepted');
      return record;
    };
    const accepted = await read();
    await harness.db.execute(sql`
      UPDATE pipeline_runs SET metadata = jsonb_set(metadata, '{owner,state}', '"lost"'::jsonb)
       WHERE id = ${runId}
    `);

    const wrote = await compareAndSet(
      runId,
      accepted.version,
      stamp(accepted, { state: 'failed' }),
      {
        runOpen: true,
      },
    );

    expect(wrote).toBe(false);
    expect((await read()).state).toBe(accepted.state);
  });
});

describe('two presses at once', () => {
  it('opens one release, and refuses the other as in flight naming it', async () => {
    await seedReleaseRunner();
    const a = await insertIssue();
    const b = await insertIssue();

    const outcomes = await Promise.allSettled([claim([a]), claim([b])]);

    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const winner = (won[0] as PromiseFulfilledResult<{ runId: string }>).value;
    expect(lost[0]?.reason).toMatchObject({ existingRunId: winner.runId });
    expect((await counts()).releases).toBe(1);
  });
});
