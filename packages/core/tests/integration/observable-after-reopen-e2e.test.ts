/**
 * ISS-967 (FB-495, agenfold, 2026-11-04) — after an issue is reopened and re-landed, its observable
 * criterion was weighed against the release that carried the issue's round BEFORE the reopen. On
 * agenfold, ISS-160's criterion 3 failed live on 0.128.0, the issue was reopened, fixed and re-landed
 * at 636cffe; the hold then asked for a verdict on 0.128.0, which does not hold the fix, read a pass at
 * the new landing as "judged at a build, not on a shipped release", and held every cut.
 *
 * Planted as agenfold stands: production deploys on land with no source probe; ISS-1 (criterion 3
 * observable) shipped in 0.128.0 beside ISS-3, failed live on it, was reopened and re-landed at a new
 * commit; ISS-2 landed and earned. A release holds an issue only for the round it carried
 * (`issues/release-evidence.ts:reworkedSince`, the one rule the release read already used), so the
 * criterion is owed after the release that carries the new round, and on it by name once it ships.
 * Against real Postgres, through the app's routes where a route exists; nothing reads production.
 *
 * @direct-test-of packages/core/src/release-batch/released-line.ts
 * @direct-test-of packages/core/src/release-batch/landed-weighing.ts
 * @direct-test-of packages/core/src/release-batch/criteria-basis.ts
 * @direct-test-of packages/core/src/release-batch/criteria-hold.ts
 * @direct-test-of packages/core/src/release-batch/hold.ts
 * @direct-test-of packages/core/src/release-batch/criteria-hold-words.ts
 * @direct-test-of packages/core/src/release-batch/blocker-sentences.ts
 * @direct-test-of packages/core/src/release-batch/release-read-views.ts
 * @direct-test-of packages/core/src/release-batch/release-read.ts
 * @direct-test-of packages/core/src/release-batch/version-store.ts
 * @direct-test-of packages/core/src/issues/release-evidence.ts
 * @direct-test-of packages/core/src/requirements/standing-identity.ts
 * @direct-test-of packages/contracts/src/released-line.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import type { ReleaseBlocker, ReleaseWarning } from '../../src/release-batch/blocker-sentences.js';
import { criteriaBasisOf, landingCriteriaReports } from '../../src/release-batch/criteria-basis.js';
import { criteriaHold } from '../../src/release-batch/criteria-hold.js';
import { landingCriteriaHold } from '../../src/release-batch/criteria-hold-words.js';
import { designed, shipped, stored } from '../helpers/agenfold-world.js';
import { api } from '../helpers/api.js';
import { seedIssueStatus } from '../helpers/factories.js';
import {
  BRANCH,
  C1,
  D9,
  F4,
  LATER,
  landedIssue,
  ok,
  seedLandedWorld,
  world,
} from '../helpers/landed-world.js';

const reads = vi.hoisted(() => ({ n: 0 }));

// a read that reaches for production is the defect the owner's rule forbids: each read counts
vi.mock('../../src/release-batch/verify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/release-batch/verify.js')>()),
  readLiveState: async () => {
    reads.n += 1;
    throw new Error('a criteria read asked production (readLiveState)');
  },
}));

const SERVING = {
  kind: 'undeclared',
  missing: 'production declares no source probe',
  route: 'declare one',
} as const;
const R1 = '0.128.0';
const R2 = '0.129.0';

/** The automatic release's hold over `waiting`, as the release read and the sweep's gate run it. */
async function hold(waiting: string[]) {
  const out: ReleaseBlocker[] = [];
  const warnings: ReleaseWarning[] = [];
  await criteriaHold(world.projectId, waiting, out, warnings, SERVING);
  return { out, warnings };
}

type Weighing = { earned: boolean | null; reason: string };

async function weighed(issueId: string): Promise<Map<number, Weighing>> {
  const body = await ok(api(world.token, 'GET', `/api/issues/${issueId}/criteria`));
  const criteria = body.criteria as Array<{ n: number; weighing: Weighing }>;
  return new Map(criteria.map((c) => [c.n, c.weighing]));
}

async function report(issueId: string) {
  const [r] = await landingCriteriaReports(world.projectId, [issueId]);
  if (!r) throw new Error('the landing weighing returned nothing');
  return r;
}

/** The judge's reopen of a shipped issue, recorded now: it leaves `closed` for another round. */
async function reopened(issueId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type,
                                    actor_agency, source, created_at)
    VALUES (${randomUUID()}, 'issue', ${issueId}, 'closed', 'reopen', 'system', 'agent', 'fixture',
            clock_timestamp())
  `);
  await seedIssueStatus(issueId, 'reopen');
}

/** The fix round re-landed at `commit`: its merge mark replaced, as a run re-marks it, and waiting. */
async function relanded(issueId: string, commit: string): Promise<void> {
  await seedIssueStatus(issueId, 'in_progress');
  await ok(api(world.token, 'DELETE', `/api/issues/${issueId}/merge`, { target: BRANCH }));
  await ok(api(world.token, 'POST', `/api/issues/${issueId}/merge`, { target: BRANCH, commit }));
  await seedIssueStatus(issueId, 'awaiting_release');
}

/**
 * agenfold's ISS-160 and ISS-161: ISS-1 (criterion 3 observable) shipped in 0.128.0 beside ISS-3,
 * its criterion 3 failed live there, it was reopened, and re-landed at F4 with criteria 1 and 2 passed
 * there; ISS-2 landed at D9 and earned every criterion.
 */
async function reopenedAfterR1(opts: { landingPass: boolean } = { landingPass: true }) {
  const fixed = await landedIssue(1, C1);
  const sibling = await landedIssue(3, LATER);
  await designed(fixed, [[3, 'observable']]);
  await designed(sibling, [[3, 'observable']]);
  await shipped([fixed, sibling], R1);
  await stored(fixed, 3, { release: R1 }, 'fail');
  await reopened(fixed);
  await relanded(fixed, F4);
  for (const n of [1, 2]) await stored(fixed, n, { commit: F4 });
  // agenfold's pass at the new landing, with clips: no live check of an observable criterion
  if (opts.landingPass) await stored(fixed, 3, { commit: F4 });
  const earned = await landedIssue(2, D9);
  for (const n of [1, 2, 3]) await stored(earned, n, { commit: D9 });
  return { fixed, earned, sibling };
}

beforeEach(async () => {
  await seedLandedWorld();
  reads.n = 0;
});

describe('a release holds an issue only for the round it carried (ISS-967)', () => {
  it('owes the re-landed observable criterion after the next release, holding no cut', async () => {
    const { fixed, earned } = await reopenedAfterR1();
    const basis = await criteriaBasisOf(world.projectId);
    expect(basis).toMatchObject({ kind: 'landing', byRecord: true });

    const r = await report(fixed);
    expect(r.unearned).toEqual([]);
    expect(r.afterRelease.map((c) => c.criterion)).toEqual([3]);
    expect(r.afterRelease[0]?.why).toContain('after the release that carries this issue ships');
    expect(r.afterRelease[0]?.why).not.toContain(R1);

    const { out, warnings } = await hold([fixed, earned]);
    expect(out.filter((b) => b.code === 'RELEASE_CRITERIA_UNEARNED')).toEqual([]);
    expect(warnings.filter((w) => w.code === 'RELEASE_CRITERIA_HELD_BACK')).toEqual([]);
    const after = warnings.find((w) => w.code === 'RELEASE_CRITERIA_AFTER_RELEASE');
    expect(after?.details?.held).toEqual([
      expect.objectContaining({ displayId: 'ISS-1', criteria: [3] }),
    ]);
    for (const said of [...out, ...warnings]) expect(said.message).not.toContain(R1);
    for (const [, w] of await weighed(fixed)) expect(w.reason).not.toContain(R1);
    expect(reads.n).toBe(0);
  });

  it('lets the fail on the earlier release that caused the reopen stop holding', async () => {
    // no verdict since the reopen: the fail on 0.128.0 is all criterion 3 has
    const { fixed, earned } = await reopenedAfterR1({ landingPass: false });
    const r = await report(fixed);
    expect(r.unearned).toEqual([]);
    expect(r.afterRelease.map((c) => c.criterion)).toEqual([3]);
    const { out, warnings } = await hold([fixed, earned]);
    expect(out.filter((b) => b.code === 'RELEASE_CRITERIA_UNEARNED')).toEqual([]);
    expect(warnings.filter((w) => w.code === 'RELEASE_CRITERIA_HELD_BACK')).toEqual([]);
  });

  it('never counts a pass on the release that carried the round before the reopen', async () => {
    const { fixed } = await reopenedAfterR1();
    await stored(fixed, 1, { release: R1 });
    const r = await report(fixed);
    const why = r.unearned.find((c) => c.criterion === 1)?.why;
    expect(why).toContain(`it was judged on release ${R1}`);
    expect(why).toContain('reopened');
    expect(why).not.toContain('the change landed after it');
  });

  it('keeps an issue never reopened owed on the release that carried it, as before', async () => {
    const { sibling } = await reopenedAfterR1();
    const r = await report(sibling);
    expect(r.afterRelease).toEqual([]);
    expect(r.unearned.find((c) => c.criterion === 3)?.why).toContain(
      `judge it on release ${R1}, naming \`{ kind: 'release', version: '${R1}' }\``,
    );
  });

  it('owes it by name on the release that carries the new round, and counts a pass there', async () => {
    const { fixed, earned } = await reopenedAfterR1();
    await shipped([fixed, earned], R2);
    const r = await report(fixed);
    expect(r.afterRelease).toEqual([]);
    const owed = r.unearned.find((c) => c.criterion === 3)?.why;
    expect(owed).toContain(
      `judge it on release ${R2}, naming \`{ kind: 'release', version: '${R2}' }\``,
    );
    expect(owed).not.toContain(R1);
    expect((await weighed(fixed)).get(3)?.reason).toContain(`judge it on release ${R2}`);

    await stored(fixed, 3, { release: R2 });
    const passed = await report(fixed);
    expect(passed.unearned).toEqual([]);
    expect(passed.counted.find((c) => c.criterion === 3)).toMatchObject({ release: R2 });
    expect(reads.n).toBe(0);
  });

  it('holds on a fail recorded on the release that carries the new round', async () => {
    const { fixed, earned } = await reopenedAfterR1();
    await shipped([fixed, earned], R2);
    await stored(fixed, 3, { release: R2 }, 'fail');
    const r = await report(fixed);
    const owed = r.unearned.find((c) => c.criterion === 3)?.why;
    expect(owed).toContain('its verdict is `fail`');
    expect(owed).toContain(`judge it on release ${R2}`);
    expect(r.afterRelease).toEqual([]);
  });

  it('asks one act for a live-only criterion a fail on this round holds, naming no landing verdict', async () => {
    const { fixed, earned } = await reopenedAfterR1();
    // a fail judged on this round, before any release carries it, is everyone's evidence
    await stored(fixed, 3, { commit: F4 }, 'fail');
    const r = await report(fixed);
    expect(r.afterRelease).toEqual([]);
    expect(r.unearned.map((c) => c.criterion)).toEqual([3]);
    const basis = await criteriaBasisOf(world.projectId);
    if (basis.kind !== 'landing') throw new Error('not weighed at the landing');
    const words = landingCriteriaHold(r, basis, 'agent');
    expect(words.reason).not.toContain(R1);
    expect(words.reason).not.toContain('judged at its landing commit');
    expect(words.reason).toContain('only the running product shows');
    const { warnings } = await hold([fixed, earned]);
    const back = warnings.find((w) => w.code === 'RELEASE_CRITERIA_HELD_BACK');
    expect(back?.message).toContain('`ISS-1` owes criterion 3');
    expect(back?.message).not.toContain('at its landing commit');
    expect(back?.message).not.toContain(R1);
  });
});
