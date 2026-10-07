/**
 * An issue claimed by a release that failed after it recorded a deploy stays claimed at its release
 * step for a person (`releasing-recovery.ts` `recoverStrandedReleasing`): its code may be live. A
 * later release Forge verified shipping, whose commit holds the issue's, settles that question, so
 * the issue is closed against it (`release-batch/shipped-earlier.ts`) instead of waiting at the gate
 * for ever beside its own live code. Against real Postgres, with the ancestry answered by a fake host.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { claimIssuesForRelease, returnTakenClaims, setWorkStep } from '../../src/issues/index.js';
import { createReleaseBatch } from '../../src/release-batch/create.js';
import { readRelease } from '../../src/release-batch/release-read.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows, truncateAll } from '../helpers/factories.js';
import { releaseWorld, seedProductionDeployTrigger, stubProbe } from '../helpers/release-world.js';
import {
  A,
  C1,
  C2,
  HISTORY,
  host,
  N,
  shippedEarlierWorld,
} from '../helpers/shipped-earlier-world.js';

let projectId: string;
let ownerId: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));
const { shipped, marked, asserted, claim, runOf } = shippedEarlierWorld(() => ({ projectId }), fx);

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
  stubProbe({});
});

const deps = { host: host(HISTORY) };

/**
 * A release run that ended `status` after recording a deploy, still claiming `issueIds` at their
 * release step: what `recoverStrandedReleasing` leaves when a run that promoted ends unfinished.
 */
async function endedHolding(
  version: string,
  issueIds: string[],
  status: 'failed' | 'running' = 'failed',
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, metadata)
    VALUES (${id}, ${projectId}, 'system', ${status}, '2026-10-06T09:00:00Z'::timestamptz, ${version},
            ${JSON.stringify({
              source: 'release-batch',
              issueIds,
              ...(status === 'failed'
                ? { failure: { code: 'deploy_failed', detail: 'the deploy failed' } }
                : {}),
            })}::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO release_attempts (run_id, stage, idempotency_key, verdict, settled_at)
    VALUES (${id}, 'deploy', ${`deploy-${id}`}, ${status === 'failed' ? 'failed' : null},
            ${status === 'failed' ? sql`now()` : null})
  `);
  for (const issueId of issueIds) {
    await db.execute(sql`UPDATE issues SET release_batch_run_id = ${id} WHERE id = ${issueId}`);
    await setWorkStep(db, issueId, 'release');
  }
  return id;
}

async function rosterClosedOf(runId: string): Promise<string[]> {
  const [row] = await rows<{ closed: string[] | null }>(sql`
    SELECT metadata -> 'rosterClosed' AS closed FROM pipeline_runs WHERE id = ${runId}
  `);
  return row?.closed ?? [];
}

async function stepOf(issueId: string): Promise<string | null> {
  const [row] = await rows<{ step: string | null }>(sql`
    SELECT step FROM issue_work_state WHERE issue_id = ${issueId}
  `);
  return row?.step ?? null;
}

async function lastComment(id: string): Promise<string | undefined> {
  const [row] = await rows<{ body: string }>(sql`
    SELECT body FROM comments WHERE issue_id = ${id} ORDER BY created_at DESC LIMIT 1
  `);
  return row?.body;
}

describe('a release that failed after it deployed strands nothing a later release shipped', () => {
  it('the sweep closes the held row against the later shipped release whose commit holds its commit', async () => {
    const id = await asserted();
    await claim(id, A);
    const failed = await endedHolding('0.4.0-dev.1', [id]);
    const later = await shipped('0.4.0-dev.2', C1, '2026-10-06T10:00:00Z');

    const result = await sweepAutomaticReleases(new Date(), deps);

    expect(result.shippedEarlier).toBe(1);
    expect(await runOf(id)).toEqual({ status: 'closed', claim: null });
    expect(await stepOf(id)).toBeNull();
    expect(await rosterClosedOf(later)).toEqual([id]);
    expect(await rosterClosedOf(failed)).toEqual([]);
    expect(await lastComment(id)).toContain(
      'Shipped in 0.4.0-dev.2 while release 0.4.0-dev.1, which claimed it, ended without shipping',
    );
  });

  it('a row whose commit no shipped release holds stays claimed by the failed release at its release step', async () => {
    const id = await marked(N);
    const failed = await endedHolding('0.4.0-dev.1', [id]);
    await shipped('0.4.0-dev.2', C2, '2026-10-06T10:00:00Z');

    const result = await sweepAutomaticReleases(new Date(), deps);

    expect(result.shippedEarlier).toBe(0);
    expect(await runOf(id)).toEqual({ status: 'awaiting_release', claim: failed });
    expect(await stepOf(id)).toBe('release');
  });

  it('of one held roster, closes the row a later release shipped and keeps the other held', async () => {
    const shippedRow = await marked(A);
    const unshipped = await marked(N);
    const failed = await endedHolding('0.4.0-dev.1', [shippedRow, unshipped]);
    await shipped('0.4.0-dev.2', C1, '2026-10-06T10:00:00Z');

    await sweepAutomaticReleases(new Date(), deps);

    expect(await runOf(shippedRow)).toEqual({ status: 'closed', claim: null });
    expect(await runOf(unshipped)).toEqual({ status: 'awaiting_release', claim: failed });
    expect(await stepOf(unshipped)).toBe('release');
  });

  it('a row taken from the ended release and not closed goes back to it, release step kept', async () => {
    const id = await marked(A);
    const failed = await endedHolding('0.4.0-dev.1', [id]);
    const later = await shipped('0.4.0-dev.2', C1, '2026-10-06T10:00:00Z');
    const live = await endedHolding('0.4.0-dev.3', [], 'running');
    const args = { projectId, issueIds: [id], gateStatus: 'awaiting_release' };

    expect(await claimIssuesForRelease({ ...args, runId: live })).toEqual([]);
    const took = await claimIssuesForRelease({ ...args, runId: later, fromEndedRelease: true });
    expect(took).toEqual([{ id, heldBy: failed }]);
    const back = await db.transaction((tx) =>
      returnTakenClaims(tx, later, [{ id, heldBy: failed }]),
    );

    expect(back).toEqual([id]);
    expect(await runOf(id)).toEqual({ status: 'awaiting_release', claim: failed });
    expect(await stepOf(id)).toBe('release');
  });

  it("lets go only the rows it took: another pass's row on the same release stays that pass's", async () => {
    const theirs = await marked(A);
    const ours = await marked(A);
    const failed = await endedHolding('0.4.0-dev.1', [theirs, ours]);
    const later = await shipped('0.4.0-dev.2', C1, '2026-10-06T10:00:00Z');
    const args = {
      projectId,
      gateStatus: 'awaiting_release',
      runId: later,
      fromEndedRelease: true,
    };
    // Another pass took `theirs` onto the release and has not closed it yet.
    await claimIssuesForRelease({ ...args, issueIds: [theirs] });

    await sweepAutomaticReleases(new Date(), deps);

    expect(await runOf(ours)).toEqual({ status: 'closed', claim: null });
    expect(await runOf(theirs)).toEqual({ status: 'awaiting_release', claim: later });
    expect(await stepOf(theirs)).toBe('release');
    const back = await db.transaction((tx) =>
      returnTakenClaims(tx, later, [{ id: theirs, heldBy: failed }]),
    );
    expect(back).toEqual([theirs]);
  });

  it('never takes a row from a release run still at work, whatever a shipped release holds', async () => {
    const id = await marked(A);
    const live = await endedHolding('0.4.0-dev.3', [id], 'running');
    await shipped('0.4.0-dev.2', C1, '2026-10-06T10:00:00Z');

    const result = await sweepAutomaticReleases(new Date(), deps);

    expect(result.shippedEarlier).toBe(0);
    expect(await runOf(id)).toEqual({ status: 'awaiting_release', claim: live });
  });

  it('a cut closes the held row first, then releases only what it was named', async () => {
    const held = await marked(A);
    await endedHolding('0.4.0-dev.1', [held]);
    await shipped('0.4.0-dev.2', C1, '2026-10-06T10:00:00Z');
    const named = await marked(N);

    await createReleaseBatch({ projectId, userId: ownerId, issueIds: [named] }, deps).catch(
      () => undefined,
    );

    expect(await runOf(held)).toEqual({ status: 'closed', claim: null });
  });

  it('each page says where the row went: the failed release lists it closed, the shipped one carries it', async () => {
    const id = await marked(A);
    await endedHolding('0.4.0-dev.1', [id]);
    await shipped('0.4.0-dev.2', C1, '2026-10-06T10:00:00Z');
    await sweepAutomaticReleases(new Date(), deps);
    const [key] = await fx.displayIds([id]);

    const failedPage = await readRelease(projectId, '0.4.0-dev.1', null);
    const shippedPage = await readRelease(projectId, '0.4.0-dev.2', null);

    expect(failedPage.state).toBe('failed');
    expect(failedPage.issues.map((i) => [i.key, i.status])).toEqual([[key, 'closed']]);
    expect(shippedPage.state).toBe('shipped');
    expect(shippedPage.issues.map((i) => [i.key, i.status])).toEqual([[key, 'closed']]);
  });
});
