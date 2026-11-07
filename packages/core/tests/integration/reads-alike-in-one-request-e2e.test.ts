// ISS-1070 r3: one read request shares what its reads would each read again, and each read answers
// what it answers alone, over a world with requirements tracing open issues, blocks edges between
// those, their modules and release holds, and releases carrying the closed ones:
// - the issue standing's own facts per issue (`issues/standing-facts-memo.ts`, `db/read-memo.ts:
//   memoizedPerId`), which Needs you's open issues and the issues its requirements trace both read;
// - the requirements' state and coverage, which the release facts read from Needs you's own list
//   (`requirements/standing-share.ts`);
// - the newest shipped and the newest live, which place every run from the keys its place reads and
//   read the picked whole (`release-read.ts:wentOutParts`);
// - the release a build is, asked of the database by its commit (`shipped-releases.ts`).
// @direct-test-of packages/core/src/db/read-memo.ts
// @direct-test-of packages/core/src/issues/standing-read.ts
// @direct-test-of packages/core/src/issues/standing-facts-memo.ts
// @direct-test-of packages/core/src/requirements/standing-share.ts
// @direct-test-of packages/core/src/requirements/read.ts
// @direct-test-of packages/core/src/release-batch/release-read.ts
// @direct-test-of packages/core/src/release-batch/release-list-read.ts
// @direct-test-of packages/core/src/release-batch/release-facts.ts
// @direct-test-of packages/core/src/release-batch/shipped-releases.ts
// @direct-test-of packages/core/src/pipeline/release-runs.ts

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withReadMemo } from '../../src/db/read-memo.js';
import { readNeedsYouDecisions } from '../../src/development/needs-you-decisions-read.js';
import { readNeedsYou } from '../../src/development/needs-you-list.js';
import { needsYouViewerOf } from '../../src/development/needs-you-viewer.js';
import { listIssueStanding } from '../../src/issues/index.js';
import { loadProjectAccess } from '../../src/lib/authz.js';
import {
  deploymentConfirms,
  latestLiveReleases,
  listReleases,
  shippedReleaseRuns,
} from '../../src/release-batch/index.js';
import { listShippedReleases } from '../../src/release-batch/release-list-read.js';
import { listRequirementsAs } from '../../src/requirements/index.js';
import { closeWorld, testEnv } from '../helpers/ecosystem-world.js';
import { createTestUser } from '../helpers/factories.js';
import { seedAtScale } from '../helpers/scale-world.js';

let ownerId: string;

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  ownerId = (await createTestUser({ verified: true })).id;
}, 120_000);

afterAll(closeWorld);

describe('inside one read request, each read answers what it answers alone (ISS-1070 r3)', () => {
  // requirements tracing open issues, blocks edges between those, their modules and release holds,
  // and releases carrying the closed ones, the newest of them this build's
  const BUILT = 'd'.repeat(40);
  let world: string;
  beforeAll(async () => {
    world = await seedAtScale(
      ownerId,
      {
        requirements: 6,
        criteriaPerRequirement: 4,
        issues: 160,
        criteriaPerIssue: 3,
        verdictsPerCriterion: 2,
        releases: 60,
        feedback: 40,
        activityPerIssue: 2,
      },
      { servingCommit: BUILT },
    );
  }, 120_000);

  it('answers Needs you, its decisions, the open issues, the requirements and the newest releases alike', async () => {
    // every read takes one clock, so a standing's times are the same instant in and out of a request
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
    try {
      const access = await loadProjectAccess(world, ownerId);
      const viewer = needsYouViewerOf(access, ownerId, 'human');
      const now = new Date();
      const reads = () => [
        readNeedsYou(world, viewer, access, now),
        readNeedsYouDecisions(world, viewer, access, now),
        listIssueStanding(world, 'open', now),
        listRequirementsAs(viewer, world),
        listShippedReleases(world, viewer, 3),
        latestLiveReleases(world),
      ];
      const alone: unknown[] = [];
      for (const read of reads()) alone.push(await read);
      const together = await withReadMemo(() => Promise.all(reads()));
      // the world holds what each shared fact is about, so no read compares two empty answers
      const [needsYou, , open, requirements, shipped] = alone as [
        { items: unknown[] },
        unknown,
        Awaited<ReturnType<typeof listIssueStanding>>,
        Awaited<ReturnType<typeof listRequirementsAs>>,
        Awaited<ReturnType<typeof listShippedReleases>>,
      ];
      expect(open.issues.some((i) => i.standing.blockedBy.length > 0)).toBe(true);
      expect(open.issues.some((i) => i.standing.releaseHold)).toBe(true);
      expect(requirements.some((r) => r.standing.coverage.some((c) => c.issues.length > 0))).toBe(
        true,
      );
      expect(shipped.releases).toHaveLength(3);
      expect(needsYou.items).toBeDefined();
      expect(together).toEqual(alone);
    } finally {
      vi.useRealTimers();
    }
  });

  it('places the newest shipped and live from every release the whole list holds', async () => {
    const all = (await listReleases(world, null)).releases;
    const wentOut = all
      .filter((r) => r.releasedAt !== null)
      .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''));
    expect((await listShippedReleases(world, null, 5)).releases).toEqual(wentOut.slice(0, 5));
  });

  it('names the releases a build is from its commit as the whole list of shipped releases names them', async () => {
    const all = await shippedReleaseRuns(world);
    const confirmed = (runs: typeof all, built: string) =>
      runs.filter((r) => deploymentConfirms(r.commit, built));
    const builds = [BUILT, BUILT.slice(0, 7), BUILT.toUpperCase(), 'e'.repeat(40), 'dddd', ''];
    for (const built of builds) {
      expect(confirmed(await shippedReleaseRuns(world, { built }), built)).toEqual(
        confirmed(all, built),
      );
    }
    expect(confirmed(all, BUILT).map((r) => r.version)).toEqual(['0.4.0-dev.60']);
    expect(await shippedReleaseRuns(world, { built: null })).toEqual([]);
  });
});
