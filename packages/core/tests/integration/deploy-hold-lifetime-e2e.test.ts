/**
 * ISS-1279 — when the hold ends, against a real Postgres.
 *
 * The acquire is proved next door in `deploy-environment-lock-e2e`. What these
 * cases are about is the release: it is derived from the deploy-hold record in
 * `pipeline_runs.metadata`, and every shape in which that record stops telling
 * the truth is either an environment held for nothing or — far worse — one
 * freed while a deploy is still reaching it.
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

let harness: TestDatabase;
let projectId: string;

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
  vi.useRealTimers();
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  projectId = (await createTestProject(harness.db, owner.id)).id;
});

const lockModule = () => import('../../src/pipeline/deploy-lock.js');

/** The `live` lock row this run holds, as a placeholder records what it speaks for (ISS-1279). */
async function liveLocks(runId: string) {
  const { readDeployLocksHeld } = await lockModule();
  return (await readDeployLocksHeld(runId)).filter((h) => h.environment === 'live');
}

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

const BINDING_B = '00000000-0000-4000-8000-0000000000b2';

const targetsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    deliveryId: `del-${i}`,
    targetLabel: `Target ${i}`,
    deploymentUuid: `dep-${i}`,
    status: 'pending' as const,
  }));

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

async function armed(runId: string, count: number): Promise<void> {
  const { openDeployDispatchHold, replaceDispatchHoldWithTargets } = await import(
    '../../src/pipeline/deploy-confirmations.js'
  );
  await openDeployDispatchHold({
    runId,
    bindingId: '00000000-0000-4000-8000-0000000000b1',
    requestId: 'req-a',
    targetLabel: 'live deploy',
    locks: await liveLocks(runId),
  });
  await replaceDispatchHoldWithTargets({
    runId,
    bindingId: '00000000-0000-4000-8000-0000000000b1',
    requestId: 'req-a',
    targets: targetsOf(count),
  });
}

describe('the hold ends when the last deploy does', () => {
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
      locks: await liveLocks(run),
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

  // The blocker shape: a run terminal BEFORE its deploy is dispatched refuses every target hold
  // with no placeholder to authorise them, so the record says nothing about what Coolify is
  // building. Read as an idle environment it frees the hold under a live deploy; its expiry, not
  // a guess about siblings, is what ends a hold nothing can account for.
  it('frees nothing when the deploys it settles were never recorded as holds', async () => {
    const { acquireDeployLocks } = await lockModule();
    const { replaceDispatchHoldWithTargets, readDeployHolds } = await import(
      '../../src/pipeline/deploy-confirmations.js'
    );
    const run = await makeRun();
    await acquireDeployLocks(request(run), ['live']);
    await harness.db.execute(sql`UPDATE pipeline_runs SET status = 'failed' WHERE id = ${run}`);

    await replaceDispatchHoldWithTargets({
      runId: run,
      bindingId: '00000000-0000-4000-8000-0000000000b1',
      targets: targetsOf(2),
    });
    expect(await readDeployHolds(run)).toEqual({});

    await settle(run, 'del-0', 'succeeded');

    expect((await lockRow('live'))?.run_id).toBe(run);
  });
});

// The record can only free what it accounted for: work a run going terminal would disown, and a
// reading of the lock table older than the lock it is about to delete.

describe('the hold ends only on a record that can answer for it', () => {
  // Half a fan-out witnessed is not the whole of it: a run going terminal between two bindings
  // refuses the second placeholder, and the first binding settling then reads a record with
  // nothing pending in it and frees the environment while the second is still building.
  it('records the sibling a run going terminal midway would otherwise disown', async () => {
    const { acquireDeployLocks } = await lockModule();
    const { openDeployDispatchHold, readDeployHolds } = await import(
      '../../src/pipeline/deploy-confirmations.js'
    );
    const run = await makeRun();
    await acquireDeployLocks(request(run), ['live']);
    expect(
      await openDeployDispatchHold({
        runId: run,
        bindingId: '00000000-0000-4000-8000-0000000000b1',
        requestId: 'req-a',
        targetLabel: 'preview deploy',
      }),
    ).toBe(true);
    await harness.db.execute(sql`UPDATE pipeline_runs SET status = 'failed' WHERE id = ${run}`);

    const second = await openDeployDispatchHold({
      runId: run,
      bindingId: BINDING_B,
      requestId: 'req-b',
      targetLabel: 'live deploy',
      authorisedBySibling: true,
      locks: await liveLocks(run),
    });

    expect(second).toBe(true);
    expect(Object.keys(await readDeployHolds(run)).sort()).toEqual([
      'dispatch:req-a',
      'dispatch:req-b',
    ]);
  });

  it('holds the environment while that disowned sibling is still building', async () => {
    const { acquireDeployLocks } = await lockModule();
    const { openDeployDispatchHold, replaceDispatchHoldWithTargets } = await import(
      '../../src/pipeline/deploy-confirmations.js'
    );
    const run = await makeRun();
    await acquireDeployLocks(request(run), ['live']);
    await openDeployDispatchHold({
      runId: run,
      bindingId: '00000000-0000-4000-8000-0000000000b1',
      requestId: 'req-a',
      targetLabel: 'preview deploy',
      locks: await liveLocks(run),
    });
    await harness.db.execute(sql`UPDATE pipeline_runs SET status = 'failed' WHERE id = ${run}`);
    await openDeployDispatchHold({
      runId: run,
      bindingId: BINDING_B,
      requestId: 'req-b',
      targetLabel: 'live deploy',
      authorisedBySibling: true,
      locks: await liveLocks(run),
    });
    await replaceDispatchHoldWithTargets({
      runId: run,
      bindingId: '00000000-0000-4000-8000-0000000000b1',
      requestId: 'req-a',
      targets: targetsOf(1),
    });

    await settle(run, 'del-0', 'succeeded');

    expect((await lockRow('live'))?.run_id).toBe(run);
  });

  // The record that said "idle" described the lock this run held THEN. A dispatch of the same run
  // taking the environment again in between is a different hold, and a release deriving from the
  // older reading must not carry it off.
  it('frees nothing a reading older than the hold could not have accounted for', async () => {
    const { acquireDeployLocks, readDeployLocksHeld, releaseDeployLocksForRun } =
      await lockModule();
    const run = await makeRun();
    await acquireDeployLocks(request(run), ['live']);
    const asRead = await readDeployLocksHeld(run);

    await expireLock('live');
    await acquireDeployLocks(request(run, 'a second dispatch of the same run'), ['live']);

    expect(await releaseDeployLocksForRun(run, asRead)).toBe(0);
    expect((await lockRow('live'))?.subject).toBe('a second dispatch of the same run');
    expect(await releaseDeployLocksForRun(run, await readDeployLocksHeld(run))).toBe(1);
  });

  // A second dispatch of the same run takes an environment the first never held. Its lock row is
  // in the settling dispatch's snapshot and its acquisition instant matches, so only the record
  // saying which environments it speaks for keeps it from being carried off (ISS-1279).
  it('frees no environment its own record does not name', async () => {
    const { acquireDeployLocks } = await lockModule();
    const { openDeployDispatchHold, replaceDispatchHoldWithTargets } = await import(
      '../../src/pipeline/deploy-confirmations.js'
    );
    const run = await makeRun();
    await acquireDeployLocks(request(run), ['live']);
    await openDeployDispatchHold({
      runId: run,
      bindingId: '00000000-0000-4000-8000-0000000000b1',
      requestId: 'req-a',
      targetLabel: 'live deploy',
      locks: await liveLocks(run),
    });
    await replaceDispatchHoldWithTargets({
      runId: run,
      bindingId: '00000000-0000-4000-8000-0000000000b1',
      requestId: 'req-a',
      targets: targetsOf(1),
    });
    // The same run dispatching again, its placeholder not yet written.
    await acquireDeployLocks(request(run, 'a preview dispatch of the same run'), ['preview']);

    await settle(run, 'del-0', 'succeeded');

    expect(await lockRow('live')).toBeNull();
    expect((await lockRow('preview'))?.subject).toBe('a preview dispatch of the same run');
  });
});

// Identity, not name: which ROW of the lock table a record speaks for, when the same run has
// taken the same environment more than once.
describe('the hold ends only on the very row its record named', () => {
  // The same run has deployed to preview once and its succeeded hold still says so. A NEW preview
  // lock, taken by a dispatch whose placeholder is not yet written, is a different row — and an
  // environment NAME left on a historical hold would hand it to the live settlement to delete.
  it('frees no later taking of an environment it deployed to before', async () => {
    const { acquireDeployLocks, readDeployLocksHeld } = await lockModule();
    const { openDeployDispatchHold, replaceDispatchHoldWithTargets } = await import(
      '../../src/pipeline/deploy-confirmations.js'
    );
    const run = await makeRun();
    const bindingId = '00000000-0000-4000-8000-0000000000b1';

    await acquireDeployLocks(request(run, 'the preview deploy'), ['preview']);
    await openDeployDispatchHold({
      runId: run,
      bindingId,
      requestId: 'req-p',
      targetLabel: 'preview deploy',
      locks: await readDeployLocksHeld(run),
    });
    await replaceDispatchHoldWithTargets({
      runId: run,
      bindingId,
      requestId: 'req-p',
      targets: [
        { deliveryId: 'del-p', targetLabel: 'P', deploymentUuid: 'dep-p', status: 'pending' },
      ],
    });
    await settle(run, 'del-p', 'succeeded');
    expect(await lockRow('preview')).toBeNull();

    await acquireDeployLocks(request(run, 'the live deploy'), ['live']);
    await openDeployDispatchHold({
      runId: run,
      bindingId,
      requestId: 'req-l',
      targetLabel: 'live deploy',
      locks: await liveLocks(run),
    });
    await replaceDispatchHoldWithTargets({
      runId: run,
      bindingId,
      requestId: 'req-l',
      targets: targetsOf(1),
    });
    // A further preview dispatch of the same run, its placeholder not yet written.
    await acquireDeployLocks(request(run, 'a second preview deploy'), ['preview']);

    await settle(run, 'del-0', 'succeeded');

    expect(await lockRow('live')).toBeNull();
    expect((await lockRow('preview'))?.subject).toBe('a second preview deploy');
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
