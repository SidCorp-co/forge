/**
 * ISS-1126 (REQ-71 r5 BC-13..15, FB-578): the automatic release is cut when the first of the
 * project's release triggers is met, never once per recording. On forge-dev each recording at
 * `awaiting_release` cut a release at once and moved `dev` under the running landing chains.
 *
 * Planted against real Postgres, production deploying `on-land`:
 * - Forge's default (a 10-minute time trigger) holds one recording, naming the trigger and when it
 *   cuts, and cuts once the wait is over, carrying what arrived meanwhile too;
 * - an outcome is carried whole: an earned issue of a requirement whose other issue is still in
 *   flight waits, naming it, and is cut with it once it lands;
 * - a count trigger cuts at its count, or at its maximum wait; a target trigger at its outcome;
 * - work landing after the cut waits for the next one, the roster frozen by the cut's claim.
 *
 * @direct-test-of packages/core/src/release-batch/release-cutoff.ts
 * @direct-test-of packages/core/src/release-batch/release-sweep.ts
 * @direct-test-of packages/core/src/release-batch/hold.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { sweepAutomaticReleases } from '../../src/release-batch/release-sweep.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  createTestFeedback,
  createTestProject,
  createTestRequirement,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';
import { declareCutoff } from '../helpers/release-cutoff-world.js';
import { declareProductionDocument, fakeCoolify, releaseWorld } from '../helpers/release-world.js';

const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const APP = { id: 't-app', label: 'App', resourceUuid: 'app-uuid' };
const MINUTE = 60_000;

let projectId: string;
let ownerId: string;
let bindingId: string;
const coolify = fakeCoolify();
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser()).id;
  projectId = (await createTestProject(ownerId)).id;
  bindingId = await fx.declareProduction({ baseUrl: coolify.url(), targets: [APP] });
  await declareProductionDocument({ projectId, ownerId, bindingId, trigger: 'on-land' });
  coolify.applications.clear();
  coolify.deployed(APP.resourceUuid, 'dep-1', SERVING, '2026-11-07T11:00:00Z');
  fx.serve(SERVING);
  await fx.seedReleaseRunner();
});

/** A recording: an issue landed and moved to `awaiting_release`, delivering `requirement` if given. */
async function recorded(requirement?: string): Promise<string> {
  const id = await fx.insertIssue('awaiting_release');
  await db.execute(sql`
    UPDATE issues SET merged_commit_sha = ${'ab12'.repeat(10)},
                      requirement_id = ${requirement ?? null}
     WHERE id = ${id}
  `);
  return id;
}

const minutesOn = (minutes: number) => new Date(Date.now() + minutes * MINUTE);
const claimOf = async (id: string) => (await fx.stored(id)).claim;

describe('the release cutoff (ISS-1126, REQ-71 BC-13..15)', () => {
  it("holds one recording on Forge's default time trigger, naming it, and cuts once it is met", async () => {
    await declareCutoff(projectId, null);
    const first = await recorded();

    const now = await sweepAutomaticReleases();
    expect(now).toMatchObject({ issuesCut: 0, projectsCut: 0, issuesBatching: 1 });
    expect(await claimOf(first)).toBeNull();
    const hold = await fx.holdOf(first);
    expect(hold?.code).toBe('RELEASE_CUTOFF_PENDING');
    expect(hold?.reason).toContain("Forge's default release triggers");
    expect(hold?.reason).toContain('it cuts at');
    expect(hold?.waitingFor).toMatch(/^the time trigger: /);
    expect(hold?.owes).toBe('agent');

    // a second recording inside the wait joins the batch rather than cutting its own
    const second = await recorded();
    expect((await sweepAutomaticReleases(minutesOn(5))).issuesCut).toBe(0);

    const cut = await sweepAutomaticReleases(minutesOn(11));
    expect(cut).toMatchObject({ issuesCut: 2, projectsCut: 1 });
    const run = await claimOf(first);
    expect(run).not.toBeNull();
    expect(await claimOf(second)).toBe(run);
    expect(await fx.holdOf(first)).toBeNull();

    // BC-15: work landing after the cut is not on the frozen roster; it waits for the next batch
    const late = await recorded();
    await sweepAutomaticReleases(minutesOn(12));
    expect(await claimOf(late)).toBeNull();
  });

  it('carries an outcome whole: an earned issue waits on its sibling still in flight', async () => {
    const req = await createTestRequirement(projectId, 90, 'one outcome, two issues');
    const done = await recorded(req.id);
    const building = await fx.insertIssue('in_progress', undefined, false);
    await db.execute(sql`UPDATE issues SET requirement_id = ${req.id} WHERE id = ${building}`);
    const [buildingKey] = await fx.displayIds([building]);

    await sweepAutomaticReleases();
    expect(await claimOf(done)).toBeNull();
    const hold = await fx.holdOf(done);
    expect(hold?.code).toBe('RELEASE_OUTCOME_INCOMPLETE');
    expect(hold?.reason).toContain(`REQ-90 waits on ${buildingKey}`);

    // the sibling lands and is recorded: the outcome is eligible, and cut whole
    await db.execute(sql`
      UPDATE issues SET merged_commit_sha = ${'cd34'.repeat(10)}, merged_at = now() WHERE id = ${building}
    `);
    const { seedIssueStatus } = await import('../helpers/factories.js');
    await seedIssueStatus(building, 'awaiting_release');
    expect((await sweepAutomaticReleases()).issuesCut).toBe(2);
    expect(await claimOf(done)).toBe(await claimOf(building));
  });

  it('a drafted or dropped sibling keeps no outcome out', async () => {
    const req = await createTestRequirement(projectId, 91, 'drafts are later work');
    const done = await recorded(req.id);
    for (const status of ['draft', 'dropped']) {
      const other = await fx.insertIssue(status, undefined, status === 'dropped');
      await db.execute(sql`UPDATE issues SET requirement_id = ${req.id} WHERE id = ${other}`);
    }
    expect((await sweepAutomaticReleases()).issuesCut).toBe(1);
    expect(await claimOf(done)).not.toBeNull();
  });

  it('counts a feedback item as an outcome too', async () => {
    const done = await recorded();
    const building = await fx.insertIssue('in_progress', undefined, false);
    await createTestFeedback(projectId, ownerId, 578, [done, building]);
    await sweepAutomaticReleases();
    expect((await fx.holdOf(done))?.reason).toContain('FB-578 waits on');
  });

  it('a count trigger cuts at its count, and holds short of it until its maximum wait', async () => {
    await declareCutoff(projectId, {
      triggers: [{ kind: 'count', outcomes: 2, maxWaitMinutes: 20 }, { kind: 'request' }],
    });
    const one = await recorded();
    await sweepAutomaticReleases();
    const hold = await fx.holdOf(one);
    expect(hold?.code).toBe('RELEASE_CUTOFF_PENDING');
    expect(hold?.reason).toContain("this project's release triggers (`release.cutoff`)");
    expect(hold?.reason).toContain('count: 1 of 2 eligible outcomes; its maximum wait ends at');

    expect((await sweepAutomaticReleases(minutesOn(19))).issuesCut).toBe(0);
    expect((await sweepAutomaticReleases(minutesOn(21))).issuesCut).toBe(1);
  });

  it('a count trigger met cuts every eligible outcome at once', async () => {
    await declareCutoff(projectId, {
      triggers: [{ kind: 'count', outcomes: 2 }, { kind: 'request' }],
    });
    await recorded();
    await recorded();
    expect((await sweepAutomaticReleases()).issuesCut).toBe(2);
  });

  it('a target trigger cuts when its outcome is eligible', async () => {
    await declareCutoff(projectId, {
      triggers: [{ kind: 'target', outcome: 'REQ-90' }, { kind: 'request' }],
    });
    const other = await recorded();
    await sweepAutomaticReleases();
    expect((await fx.holdOf(other))?.reason).toContain('target: REQ-90 is not eligible yet');

    const req = await createTestRequirement(projectId, 90, 'the target');
    await recorded(req.id);
    expect((await sweepAutomaticReleases()).issuesCut).toBe(2);
  });
});
