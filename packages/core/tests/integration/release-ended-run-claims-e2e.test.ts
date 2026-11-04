/**
 * ISS-961, as agenfold's 0.123.0 met it on 2026-11-04: the 0.122.0 release failed at its deploy and
 * kept its roster claimed, as a run that recorded a deploy does (`release-claim.ts:releaseEndedRunClaims`)
 * until an agent aborts it. The next cut read its roster as the unclaimed gate issues, so it passed
 * over ISS-137, ISS-139 and ISS-141 in silence and nothing said the abort was owed. Planted here
 * through the app's own doors against real Postgres: a release fails at deploy with its roster
 * claimed, new work reaches the gate, and the next cut is read at readiness, on the releases list
 * and its draft, at the cut itself, and at the sweep; then the abort the reads name frees them.
 *
 * @direct-test-of packages/core/src/release-batch/ended-claims.ts
 * @direct-test-of packages/core/src/release-batch/blockers.ts
 * @direct-test-of packages/core/src/release-batch/release-read.ts
 * @direct-test-of packages/core/src/release-batch/release-sweep.ts
 * @direct-test-of packages/core/src/issues/release-claim.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { releaseEndedRunClaims } from '../../src/issues/index.js';
import { closeRunIfOneShot } from '../../src/pipeline/index.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { api, type Body, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { refusalsOf } from '../helpers/landed-world.js';
import { releaseWorld, seedProductionDeployTrigger } from '../helpers/release-world.js';

const CODE = 'RELEASE_HELD_BY_ENDED_RUN';

let projectId: string;
let ownerId: string;
let token: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

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
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  await fx.declareProduction({ baseUrl: 'http://coolify.invalid', targets: [] });
  await fx.seedReleaseRunner();
});

/** The release's deploy, recorded as the release job records it before it promotes. */
async function recordDeploy(runId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO release_attempts (run_id, stage, idempotency_key, verdict, settled_at)
    VALUES (${runId}, 'deploy', ${`deploy-${runId}`}, 'failed', now())
  `);
}

/** A cut of `ids` that deployed and failed there, then the minute's sweep of ended claims. */
async function failedAtDeploy(ids: string[]): Promise<{ runId: string; version: string }> {
  const cut = await fx.claim(ids);
  await recordDeploy(cut.runId);
  await closeRunIfOneShot(cut.runId, 'failed', {
    code: 'deploy_failed',
    detail: 'the production deploy reported failed (planted)',
  });
  await releaseEndedRunClaims();
  return { runId: cut.runId, version: String(cut.version) };
}

type Gate = { code: string; message?: string; detail?: string; sentence?: string };

const readiness = async (): Promise<Body> => {
  const res = await api(token, 'GET', `/api/projects/${projectId}/release-readiness`);
  expect(res.status).toBe(200);
  return res.body;
};

const releases = async (): Promise<Body> => {
  const res = await api(token, 'GET', `/api/projects/${projectId}/releases`);
  expect(res.status).toBe(200);
  return res.body;
};

const named = (list: unknown): Gate | undefined =>
  (list as Gate[] | undefined)?.find((g) => g.code === CODE);

describe('a release that failed at deploy, with its roster still claimed, then a re-cut', () => {
  it('names the passed-over roster and the owed abort at every read of the next cut, and the abort frees it', async () => {
    const held = [await fx.insertIssue(), await fx.insertIssue()];
    const failed = await failedAtDeploy(held);
    // the claims outlive the sweep: the run recorded a deploy, so a person or agent settles it
    expect((await fx.stored(held[0] as string)).claim).toBe(failed.runId);
    const keys = await fx.displayIds(held);
    const fresh = await fx.insertIssue();

    // readiness: the next cut is refused naming the roster, the run and the abort that frees it
    const ready = await readiness();
    const blocker = named(ready.blockers);
    expect(blocker, `readiness names ${CODE}`).toBeDefined();
    for (const key of keys) expect(blocker?.message).toContain(key);
    expect(blocker?.message).toContain(failed.runId);
    expect(blocker?.message).toContain(failed.version);
    expect(blocker?.message).toContain(
      `/api/projects/${projectId}/release-batches/${failed.runId}/abort`,
    );

    // the releases list: the run owes an abort, with its issues; the draft's gates name it too
    const list = await releases();
    expect(list.endedRunHolds).toEqual([
      expect.objectContaining({
        runId: failed.runId,
        version: failed.version,
        runStatus: 'failed',
        act: 'abort',
        shippedIn: null,
        issues: held.map((issueId, i) => ({ issueId, key: keys[i] })),
      }),
    ]);
    const draft = (list.releases as Array<{ state: string; version: string }>).find(
      (r) => r.state === 'draft',
    );
    expect(draft, 'the new work is drafted').toBeDefined();
    const drafted = await api(
      token,
      'GET',
      `/api/projects/${projectId}/releases/${draft?.version}`,
    );
    expect(drafted.status).toBe(200);
    const gate = named((drafted.body.release as { gates: Gate[] }).gates);
    expect(gate, 'the draft names the held roster').toBeDefined();
    for (const key of keys) expect(gate?.detail).toContain(key);

    // the cut itself: refused by name, never a cut that silently leaves the roster out
    const cut = await api(token, 'POST', `/api/projects/${projectId}/release-batches`, {
      issueIds: [fresh],
    });
    expect(cut.status).toBe(409);
    expect(refusalsOf(cut.body).map((r) => r.code)).toContain(CODE);
    expect((await fx.stored(fresh)).claim).toBeNull();

    // the sweep that cuts on land: holds the waiting row naming the run, its roster and the abort
    await seedProductionDeployTrigger(projectId, ownerId, 'on-land');
    const swept = await sweepAutomaticReleases();
    expect(swept.endedRunClaims).toBe(2);
    expect(swept.issuesCut).toBe(0);
    const hold = await fx.holdOf(fresh);
    expect(hold?.code).toBe(CODE);
    for (const key of keys) expect(hold?.reason).toContain(key);
    expect(hold?.reason).toContain('/abort');

    // the act the reads name frees the roster, and the next cut carries all three
    const abort = await api(
      token,
      'POST',
      `/api/projects/${projectId}/release-batches/${failed.runId}/abort`,
      { reason: 'the deploy failed', promotedRoster: 'return-to-gate', pushed: false },
    );
    expect(abort.status).toBe(200);
    expect((await fx.stored(held[0] as string)).claim).toBeNull();
    expect(named((await readiness()).blockers)).toBeUndefined();
    expect((await releases()).endedRunHolds).toEqual([]);
    const next = await api(token, 'POST', `/api/projects/${projectId}/release-batches`, {
      issueIds: [...held, fresh],
    });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
  });

  it('names no abort for a release still running, which holds its roster as its own', async () => {
    const live = await fx.claim([await fx.insertIssue()]);
    await recordDeploy(live.runId);
    await fx.insertIssue();

    const ready = await readiness();
    expect(named(ready.blockers)).toBeUndefined();
    expect((ready.blockers as Gate[]).map((b) => b.code)).toContain('BATCH_IN_FLIGHT');
    expect((await releases()).endedRunHolds).toEqual([]);
  });
});
