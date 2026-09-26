/**
 * ISS-1279 — one deploy reaches one environment at a time.
 *
 * The whole point of this suite is the race: a lock proved only by taking it
 * twice in sequence is evidence for nothing, because the sequence is exactly
 * the case a read-then-write also survives. Every acquire that matters here
 * goes out with `Promise.all` against a real Postgres.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
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

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  await registerIntegrationsForTest();
}, 60_000);

const fx = releaseBatchFixture(
  () => harness,
  () => ({ projectId, ownerId }),
);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  vi.useRealTimers();
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  projectId = (await createTestProject(harness.db, owner.id)).id;
});

const lockModule = () => import('../../src/pipeline/deploy-lock.js');

async function makeRun(): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
    VALUES (${id}, ${projectId}, 'system', 'running', ${JSON.stringify({ source: 'release-batch' })}::jsonb)
  `);
  return id;
}

async function lockRow(environment: string) {
  const rows = await harness.db.execute<{
    run_id: string;
    subject: string;
    reclaimed_from_run_id: string | null;
    reclaimed_at: Date | null;
  }>(sql`
    SELECT run_id, subject, reclaimed_from_run_id, reclaimed_at
      FROM deploy_locks
     WHERE project_id = ${projectId} AND environment = ${environment}
  `);
  return rows[0] ?? null;
}

async function expireLock(environment: string, by = '1 minute'): Promise<void> {
  await harness.db.execute(sql`
    UPDATE deploy_locks
       SET expires_at = now() - ${by}::interval
     WHERE project_id = ${projectId} AND environment = ${environment}
  `);
}

const request = (runId: string, subject = 'live deploy (binding b-1)') => ({
  projectId,
  runId,
  subject,
});

/** One settled outcome per acquire, so a race can be read rather than thrown. */
async function race(
  attempts: Array<() => Promise<void>>,
): Promise<Array<{ ok: true } | { ok: false; err: unknown }>> {
  return Promise.all(
    attempts.map((run) =>
      run().then(
        () => ({ ok: true }) as const,
        (err: unknown) => ({ ok: false, err }) as const,
      ),
    ),
  );
}

describe('one deploy reaches one environment at a time', () => {
  it('lets exactly one of two concurrent acquires of one environment through', async () => {
    const { acquireDeployLocks, DeployEnvironmentLockedError } = await lockModule();
    const [a, b] = [await makeRun(), await makeRun()];

    const outcomes = await race([
      () => acquireDeployLocks(request(a), ['live']),
      () => acquireDeployLocks(request(b), ['live']),
    ]);

    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    const refused = outcomes.find((o) => !o.ok) as { ok: false; err: unknown };
    expect(refused.err).toBeInstanceOf(DeployEnvironmentLockedError);
    const held = await lockRow('live');
    expect([a, b]).toContain(held?.run_id);
  });

  it('names the environment, the holder, its subject, its start, its end and what ends it', async () => {
    const { acquireDeployLocks, DeployEnvironmentLockedError } = await lockModule();
    const holder = await makeRun();
    const second = await makeRun();
    await acquireDeployLocks(request(holder, 'live deploy (binding b-7)'), ['live']);

    const err = await acquireDeployLocks(request(second), ['live']).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DeployEnvironmentLockedError);
    const message = (err as Error).message;
    expect(message).toContain('DEPLOY_ENVIRONMENT_LOCKED');
    expect(message).toContain('`live` environment');
    expect(message).toContain(holder);
    expect(message).toContain('live deploy (binding b-7)');
    const row = await harness.db.execute<{ acquired_at: Date; expires_at: Date }>(sql`
      SELECT acquired_at, expires_at FROM deploy_locks
       WHERE project_id = ${projectId} AND environment = 'live'
    `);
    expect(message).toContain(new Date(row[0]?.acquired_at as Date).toISOString());
    expect(message).toContain(new Date(row[0]?.expires_at as Date).toISOString());
    expect(message).toContain('when that deploy ends');
  });

  it('lets two concurrent acquires of two environments both through', async () => {
    const { acquireDeployLocks } = await lockModule();
    const [a, b] = [await makeRun(), await makeRun()];

    const outcomes = await race([
      () => acquireDeployLocks(request(a), ['live']),
      () => acquireDeployLocks(request(b), ['preview']),
    ]);

    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect((await lockRow('live'))?.run_id).toBe(a);
    expect((await lockRow('preview'))?.run_id).toBe(b);
  });

  it('takes a two-environment set whole or not at all', async () => {
    const { acquireDeployLocks, DeployEnvironmentLockedError } = await lockModule();
    const holder = await makeRun();
    const comer = await makeRun();
    // `preview`, not `live`: the acquire sorts, so `live` is attempted FIRST and is the one this
    // call takes before it is refused. Holding `live` instead would refuse on the first statement
    // and leave nothing to roll back, which is the case that passes whatever the rollback does.
    await acquireDeployLocks(request(holder, 'preview deploy (binding b-9)'), ['preview']);

    const err = await acquireDeployLocks(request(comer), ['preview', 'live']).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(DeployEnvironmentLockedError);
    expect(await lockRow('live')).toBeNull();
    const preview = await lockRow('preview');
    expect(preview?.run_id).toBe(holder);
    expect(preview?.subject).toBe('preview deploy (binding b-9)');
  });

  it('leaves the environment it rolled back free for the next taker', async () => {
    const { acquireDeployLocks } = await lockModule();
    const holder = await makeRun();
    const comer = await makeRun();
    const next = await makeRun();
    await acquireDeployLocks(request(holder), ['preview']);
    await acquireDeployLocks(request(comer), ['preview', 'live']).catch(() => undefined);

    await acquireDeployLocks(request(next), ['live']);

    expect((await lockRow('live'))?.run_id).toBe(next);
  });
});

describe('a hold whose owner is gone reads as free', () => {
  it('reclaims a hold whose expiry has passed, and records what it displaced', async () => {
    const { acquireDeployLocks } = await lockModule();
    const dead = await makeRun();
    const next = await makeRun();
    await acquireDeployLocks(request(dead), ['live']);
    await expireLock('live');

    await acquireDeployLocks(request(next, 'live deploy (binding b-2)'), ['live']);

    const row = await lockRow('live');
    expect(row?.run_id).toBe(next);
    expect(row?.reclaimed_from_run_id).toBe(dead);
    expect(row?.reclaimed_at).not.toBeNull();
  });

  it('reclaims a hold whose expiry is exactly the statement’s own reading of the clock', async () => {
    const { acquireDeployLocks } = await lockModule();
    const dead = await makeRun();
    const next = await makeRun();
    await acquireDeployLocks(request(dead), ['live']);
    await expireLock('live', '0 seconds');

    await acquireDeployLocks(request(next), ['live']);

    expect((await lockRow('live'))?.run_id).toBe(next);
  });

  it('reads expiry off the database clock, not the process clock', async () => {
    const { acquireDeployLocks } = await lockModule();
    const dead = await makeRun();
    const next = await makeRun();
    await acquireDeployLocks(request(dead), ['live']);
    await expireLock('live');

    // Only `Date` is faked: the postgres driver's own timers must keep running,
    // and what this case is about is whose clock decides the expiry.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 60 * 60_000));
    try {
      await acquireDeployLocks(request(next), ['live']);
    } finally {
      vi.useRealTimers();
    }

    expect((await lockRow('live'))?.run_id).toBe(next);
  });

  it('gives up on an uncommitted acquire rather than waiting for ever', async () => {
    const { acquireDeployLocks, DeployEnvironmentLockedError, DEPLOY_LOCK_WAIT_MS } =
      await lockModule();
    const holder = await makeRun();
    const comer = await makeRun();
    await acquireDeployLocks(request(holder), ['live']);
    await expireLock('live');

    // A transaction that has taken the row and will not commit until told: the
    // shape `lock_timeout` exists for, and the one case where nothing can be
    // read back about who holds the environment.
    const blocker = harness.client.begin(async (tx) => {
      await tx`UPDATE deploy_locks SET subject = 'held open'
                WHERE project_id = ${projectId} AND environment = 'live'`;
      await new Promise((done) => setTimeout(done, DEPLOY_LOCK_WAIT_MS * 2));
    });

    await new Promise((done) => setTimeout(done, 200));
    const started = Date.now();
    const err = await acquireDeployLocks(request(comer), ['live']).catch((e: unknown) => e);
    const waited = Date.now() - started;
    await blocker;

    expect(err).toBeInstanceOf(DeployEnvironmentLockedError);
    expect((err as Error).message).toContain('has not committed');
    expect(waited).toBeLessThan(DEPLOY_LOCK_WAIT_MS * 2);
    expect(await lockRow('preview')).toBeNull();
    expect((await lockRow('live'))?.run_id).toBe(holder);
  }, 30_000);

  it('frees only what the settling run itself holds', async () => {
    const { acquireDeployLocks, releaseDeployLocksForRun } = await lockModule();
    const mine = await makeRun();
    const theirs = await makeRun();
    await acquireDeployLocks(request(mine), ['live']);
    await acquireDeployLocks(request(theirs), ['preview']);

    expect(await releaseDeployLocksForRun(mine)).toBe(1);

    expect(await lockRow('live')).toBeNull();
    expect((await lockRow('preview'))?.run_id).toBe(theirs);
  });

  it('frees nothing for a run that took no lock', async () => {
    const { acquireDeployLocks, releaseDeployLocksForRun } = await lockModule();
    const holder = await makeRun();
    const unrelated = await makeRun();
    await acquireDeployLocks(request(holder), ['live']);

    expect(await releaseDeployLocksForRun(unrelated)).toBe(0);

    expect((await lockRow('live'))?.run_id).toBe(holder);
  });

  it('leaves a reclaimed run unable to free its successor', async () => {
    const { acquireDeployLocks, releaseDeployLocksForRun } = await lockModule();
    const dead = await makeRun();
    const next = await makeRun();
    await acquireDeployLocks(request(dead), ['live']);
    await expireLock('live');
    await acquireDeployLocks(request(next), ['live']);

    expect(await releaseDeployLocksForRun(dead)).toBe(0);

    expect((await lockRow('live'))?.run_id).toBe(next);
  });

  // This row ADDS a guard. Removing `BATCH_IN_FLIGHT` is ISS-1280's, after this
  // one lands, and landing them together would leave a window with neither.
  it('leaves BATCH_IN_FLIGHT raised at the batch door, with the sentence it has always had', async () => {
    await fx.declareProduction();
    const { collectReleaseBlockers } = await import('../../src/release-batch/blockers.js');
    const { releaseBlockerSentence } = await import('../../src/release-batch/blocker-sentences.js');
    const running = await makeRun();

    const report = await collectReleaseBlockers(projectId);

    const inFlight = report.blockers.find((b) => b.code === 'BATCH_IN_FLIGHT');
    expect(inFlight).toBeDefined();
    expect((inFlight?.details as { runId?: string } | undefined)?.runId).toBe(running);
    expect(inFlight?.message).toBe(releaseBlockerSentence('BATCH_IN_FLIGHT'));
    expect(inFlight?.message).toContain('A release is already running for this project');
  });

  it('refuses an environment the deploy stages do not name', async () => {
    const { acquireDeployLocks } = await lockModule();
    const run = await makeRun();

    const err = await acquireDeployLocks(request(run), ['staging']).catch((e: unknown) => e);

    expect((err as { cause?: { constraint_name?: string } }).cause?.constraint_name).toBe(
      'deploy_locks_environment_chk',
    );
  });
});

// Against the real bookkeeping, not a mock of it: the hold record is what the release decision
// reads, so a hold that stops telling the truth is an environment held with nothing deploying.
describe('the hold ends when the last deploy does', () => {
  const BINDING_B = '00000000-0000-4000-8000-0000000000b2';

  const targetsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      deliveryId: `del-${i}`,
      targetLabel: `Target ${i}`,
      deploymentUuid: `dep-${i}`,
      status: 'pending' as const,
    }));

  async function armed(runId: string, count: number): Promise<void> {
    const { replaceDispatchHoldWithTargets } = await import(
      '../../src/pipeline/deploy-confirmations.js'
    );
    await replaceDispatchHoldWithTargets({
      runId,
      bindingId: '00000000-0000-4000-8000-0000000000b1',
      targets: targetsOf(count),
    });
  }

  const settle = async (
    runId: string,
    deliveryId: string,
    verdict: 'succeeded' | 'failed',
  ): Promise<void> => {
    const { applyDeploySettlement } = await import('../../src/integrations/coolify/confirm.js');
    await applyDeploySettlement(
      {
        bindingId: '00000000-0000-4000-8000-0000000000b1',
        runId,
        deliveryId,
        deploymentUuid: `dep-${deliveryId}`,
        targetLabel: deliveryId,
      },
      verdict,
    );
  };

  it('frees it only after the last of three targets, though the first failed the run', async () => {
    const { acquireDeployLocks } = await lockModule();
    const run = await makeRun();
    await acquireDeployLocks(request(run), ['live']);
    await armed(run, 3);

    await settle(run, 'del-0', 'failed');
    expect((await lockRow('live'))?.run_id).toBe(run);

    await settle(run, 'del-1', 'succeeded');
    expect((await lockRow('live'))?.run_id).toBe(run);

    await settle(run, 'del-2', 'succeeded');
    expect(await lockRow('live')).toBeNull();
  });

  // A second binding fanning out while a first one has already failed the run. Its targets are
  // deploys Coolify accepted, so they go on the record whatever the run's status: refusing them
  // and dropping their placeholder anyway leaves a run with no holds, which every reader takes
  // for a deploy that finished — and this environment then reads free while C is still building.
  async function twoBindingsOneFailed(run: string): Promise<void> {
    const { openDeployDispatchHold, replaceDispatchHoldWithTargets } = await import(
      '../../src/pipeline/deploy-confirmations.js'
    );
    await openDeployDispatchHold({
      runId: run,
      bindingId: BINDING_B,
      requestId: 'req-b',
      targetLabel: 'live deploy',
    });
    await armed(run, 1);
    await settle(run, 'del-0', 'failed');
    await replaceDispatchHoldWithTargets({
      runId: run,
      bindingId: BINDING_B,
      requestId: 'req-b',
      targets: [
        { deliveryId: 'del-b', targetLabel: 'B', deploymentUuid: 'dep-b', status: 'pending' },
        { deliveryId: 'del-c', targetLabel: 'C', deploymentUuid: 'dep-c', status: 'pending' },
      ],
    });
  }

  it('records the targets of a binding that fans out after the run has already failed', async () => {
    const { acquireDeployLocks } = await lockModule();
    const { readDeployHolds } = await import('../../src/pipeline/deploy-confirmations.js');
    const run = await makeRun();
    await acquireDeployLocks(request(run), ['live']);

    await twoBindingsOneFailed(run);

    expect(Object.keys(await readDeployHolds(run)).sort()).toEqual([
      'target:del-0',
      'target:del-b',
      'target:del-c',
    ]);
  });

  it('holds the environment while that second binding is still building', async () => {
    const { acquireDeployLocks } = await lockModule();
    const run = await makeRun();
    await acquireDeployLocks(request(run), ['live']);
    await twoBindingsOneFailed(run);

    await settle(run, 'del-b', 'succeeded');

    expect((await lockRow('live'))?.run_id).toBe(run);
  });

  it('frees it once that second binding\u2019s last target ends', async () => {
    const { acquireDeployLocks } = await lockModule();
    const run = await makeRun();
    await acquireDeployLocks(request(run), ['live']);
    await twoBindingsOneFailed(run);
    await settle(run, 'del-b', 'succeeded');

    await settle(run, 'del-c', 'succeeded');

    expect(await lockRow('live')).toBeNull();
  });

  it('lets the next release take the environment the moment that last target ends', async () => {
    const { acquireDeployLocks } = await lockModule();
    const run = await makeRun();
    const next = await makeRun();
    await acquireDeployLocks(request(run), ['live']);
    await armed(run, 2);
    await settle(run, 'del-0', 'failed');
    await settle(run, 'del-1', 'succeeded');

    await acquireDeployLocks(request(next), ['live']);

    expect((await lockRow('live'))?.run_id).toBe(next);
  });
});
