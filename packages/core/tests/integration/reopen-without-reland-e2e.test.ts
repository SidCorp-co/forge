/**
 * ISS-971 (FB-497, agenfold, 2026-11-05) — ISS-967 made a release hold an issue only for the round it
 * carried, reading every issue reopened after a release claimed it as reworked there, whether or not
 * anything re-landed. agenfold's ISS-5 shipped in 0.34.0 at landing c633f84 and was reopened later;
 * nothing landed on it since, so its mark still names c633f84, an ancestor of 0.133.0. Its criterion 10
 * (REQ-1 BC-2) was judged pass on 0.133.0 and refused "which carried this issue before it was
 * reopened, not the fix landed since", REQ-1 read BC-2 not_live, and no build could ever earn it.
 *
 * Planted as agenfold stands: production with no source probe, so its releases are its agent's record
 * by version; ISS-1 traces BC-2 and shipped in R1 at landing C1, was reopened after R1 and never
 * re-landed (its mark C1 stands), and R2, recorded later at a higher version for another issue, carries
 * R1. A release carried a rejected round only where the issue's current landing came after its claim,
 * or no landing stands now (`issues/release-evidence.ts:reworkedSince`). Against real Postgres, through
 * the app's routes where a route exists; nothing reads production. ISS-967's own replay (reopened AND
 * re-landed) stays in `observable-after-reopen-e2e.test.ts`.
 *
 * @direct-test-of packages/core/src/issues/release-evidence.ts
 * @direct-test-of packages/core/src/release-batch/released-line.ts
 * @direct-test-of packages/core/src/release-batch/release-read-views.ts
 * @direct-test-of packages/core/src/release-batch/criteria-basis.ts
 * @direct-test-of packages/core/src/requirements/standing-identity.ts
 * @direct-test-of packages/contracts/src/released-line.ts
 */

import { randomUUID } from 'node:crypto';
import { releaseHoldsIssue } from '@forge/contracts/released-line';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { landingCriteriaReports } from '../../src/release-batch/criteria-basis.js';
import { releasedLineOf } from '../../src/release-batch/released-line.js';
import { shipped, stored } from '../helpers/agenfold-world.js';
import { api } from '../helpers/api.js';
import { seedIssueStatus } from '../helpers/factories.js';
import { agreedRequirement, bcOf, traced } from '../helpers/landed-requirement.js';
import {
  BRANCH,
  C1,
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

const R1 = '0.34.0';
const R2 = '0.133.0';
const EARLIER_ROUND = 'which carried this issue before it was reopened';

/** A judge's reopen of the shipped issue, recorded now; nothing re-lands, so its mark stands. */
async function reopened(issueId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO kernel_transitions (id, entity, entity_id, from_status, to_status, actor_type,
                                    actor_agency, source, created_at)
    VALUES (${randomUUID()}, 'issue', ${issueId}, 'closed', 'reopen', 'system', 'agent', 'fixture',
            clock_timestamp())
  `);
  await seedIssueStatus(issueId, 'reopen');
}

type Weighing = { earned: boolean | null; reason: string };

async function weighing(issueId: string, n: number): Promise<Weighing | undefined> {
  const body = await ok(api(world.token, 'GET', `/api/issues/${issueId}/criteria`));
  return (body.criteria as Array<{ n: number; weighing: Weighing }>).find((c) => c.n === n)
    ?.weighing;
}

async function report(issueId: string) {
  const [r] = await landingCriteriaReports(world.projectId, [issueId]);
  if (!r) throw new Error('the landing weighing returned nothing');
  return r;
}

/** The release read's notes for `version`: which issues it names reworked. */
async function reworkedOn(version: string): Promise<string[]> {
  const body = await ok(
    api(world.token, 'GET', `/api/projects/${world.projectId}/releases/${version}`),
  );
  const release = body.release as { notes: { reworked: Array<{ key: string }> } };
  return release.notes.reworked.map((r) => r.key);
}

/**
 * agenfold's ISS-5 under REQ-1: ISS-1's criterion 2 traces BC-2; it shipped in R1 at C1 and was
 * reopened after it; R2, recorded later for ISS-2, carries R1 and is what the record says is live.
 */
async function reopenedAfterR1() {
  const req = await agreedRequirement([
    'A member opens the workspace',
    'A workspace lists its folds',
  ]);
  const fixed = await landedIssue(1, C1);
  await traced(req, fixed, 1, { 2: 'BC-2' });
  await shipped([fixed], R1);
  await reopened(fixed);
  const other = await landedIssue(2, LATER);
  await shipped([other], R2);
  return { req, fixed };
}

beforeEach(async () => {
  await seedLandedWorld();
  reads.n = 0;
});

describe('a reopen that leaves the landing unchanged keeps the release that shipped it holding it (ISS-971)', () => {
  it('holds the issue on R1 and on R2, which carries R1, and names it reworked on neither', async () => {
    const { fixed } = await reopenedAfterR1();
    const line = await releasedLineOf(world.projectId);
    expect(line?.live?.version).toBe(R2);
    expect(line?.shipped.get(R1)?.reworked).toEqual([]);
    expect(releaseHoldsIssue(line, R1, fixed)).toBe(true);
    expect(releaseHoldsIssue(line, R2, fixed)).toBe(true);
    expect(await reworkedOn(R1)).toEqual([]);
  });

  it('counts a pass on R2 for the issue and for the requirement, naming no reopen', async () => {
    const { req, fixed } = await reopenedAfterR1();
    await stored(fixed, 2, { release: R2 });

    const r = await report(fixed);
    expect(r.unearned.find((c) => c.criterion === 2)).toBeUndefined();
    expect(r.counted.find((c) => c.criterion === 2)).toMatchObject({ release: R2 });
    const w = await weighing(fixed, 2);
    expect(w?.earned).toBe(true);
    expect(w?.reason).not.toContain(EARLIER_ROUND);

    const bc = await bcOf(req, 'BC-2');
    expect(bc.verdict).toBe('passing');
    expect(bc.issues.map((i) => i.notCounted)).toEqual([null]);
    expect(JSON.stringify(bc)).not.toContain(EARLIER_ROUND);
    expect(reads.n).toBe(0);
  });

  it('counts a pass on R1, carried by live R2, for the issue and for the requirement', async () => {
    const { req, fixed } = await reopenedAfterR1();
    await stored(fixed, 2, { release: R1 });

    const r = await report(fixed);
    expect(r.unearned.find((c) => c.criterion === 2)).toBeUndefined();
    expect((await weighing(fixed, 2))?.earned).toBe(true);
    const bc = await bcOf(req, 'BC-2');
    expect(bc.verdict).toBe('passing');
    expect(bc.issues.map((i) => i.notCounted)).toEqual([null]);
    expect(JSON.stringify(bc)).not.toContain(EARLIER_ROUND);
  });
});

describe('a reopen whose landing was cleared reads as a rework under way (ISS-967, ISS-971)', () => {
  it('holds no current round on R1 once the mark is deleted and nothing has re-landed', async () => {
    const { req, fixed } = await reopenedAfterR1();
    await ok(api(world.token, 'DELETE', `/api/issues/${fixed}/merge`, { target: BRANCH }));
    const line = await releasedLineOf(world.projectId);
    expect(line?.shipped.get(R1)?.reworked).toEqual([fixed]);
    expect(releaseHoldsIssue(line, R1, fixed)).toBe(false);
    expect(releaseHoldsIssue(line, R2, fixed)).toBe(false);
    expect(await reworkedOn(R1)).toEqual(['ISS-1']);

    await stored(fixed, 2, { release: R1 });
    const bc = await bcOf(req, 'BC-2');
    expect(bc.issues.map((i) => i.notCounted)).toEqual([expect.stringContaining(EARLIER_ROUND)]);
  });
});
