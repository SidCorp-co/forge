// ISS-1070 r21: who stands in a person's projects beside them is read once for all of them at the
// request's quiet point: a run read names its viewer with the project's holders, a feedback list asks
// its reporters' names as soon as its rows are known, a release's notes are one read for who owes its
// acts and its record gaps, its facts read a close of the reopened issues alone, and a reopened issue's
// mark time is read as its core. Each project's reads answer there what they answer alone, with each
// project's own agent as an admin, a QA member and feedback filed by agents outside the person's
// projects (`tests/helpers/live-mix-people.ts`). Its own suite, so the reads-alike suites coordinate
// no more modules than archmap allows (no-coordinator-blob).
// @direct-test-of packages/core/src/runs/viewer-context.ts
// @direct-test-of packages/core/src/permissions/holders-named.ts
// @direct-test-of packages/core/src/feedback/list-read.ts
// @direct-test-of packages/core/src/issues/release-record-required.ts
// @direct-test-of packages/core/src/release-batch/release-owes.ts
// @direct-test-of packages/core/src/release-batch/release-facts.ts
// @direct-test-of packages/core/src/issues/release-evidence.ts

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newQueryTiming, withQueryTiming } from '../../src/db/query-timing.js';
import { readAcross, withReadMemo } from '../../src/db/read-memo.js';
import { needsYouViewerOf } from '../../src/development/needs-you-viewer.js';
import { loadProjectAccess } from '../../src/lib/authz.js';
import { readHomeProject } from '../../src/product-progress/home-moving.js';
import { listReleases } from '../../src/release-batch/index.js';
import { listShippedReleases } from '../../src/release-batch/release-list-read.js';
import { closeWorld, testEnv } from '../helpers/ecosystem-world.js';
import { createTestUser, seedOrg } from '../helpers/factories.js';
import { peopleAsLive } from '../helpers/live-mix-people.js';
import { type Scale, seedAtScale } from '../helpers/scale-world.js';

// the scale `reads-alike-in-one-request-e2e.test.ts` reads across
const SMALL: Scale = {
  requirements: 4,
  criteriaPerRequirement: 3,
  issues: 90,
  criteriaPerIssue: 2,
  verdictsPerCriterion: 2,
  releases: 30,
  feedback: 20,
  activityPerIssue: 2,
  open: 30,
  live: true,
  states: true,
};

let personId: string;
let worlds: string[];

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  personId = (await createTestUser({ verified: true })).id;
  const orgId = await seedOrg(personId);
  worlds = [];
  for (let n = 0; n < 3; n++)
    worlds.push(await seedAtScale(personId, n === 1 ? { ...SMALL, batches: 3 } : SMALL, { orgId }));
  await peopleAsLive(worlds);
}, 180_000);

afterAll(closeWorld);

describe("inside one read across a person's projects, who stands beside them reads alike (ISS-1070 r21)", () => {
  it("answers each project's home part, releases and shipped releases alike", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
    try {
      const now = new Date();
      const reads = async (projectId: string) => {
        const access = await loadProjectAccess(projectId, personId);
        const viewer = needsYouViewerOf(access, personId, 'human');
        return Promise.all([
          readHomeProject({ userId: personId, agency: 'human' }, projectId, now).then((part) => ({
            feedback: part.allFeedback,
            runs: [...part.reads.runs],
          })),
          listReleases(projectId, viewer),
          listShippedReleases(projectId, viewer, 5),
        ]);
      };
      const alone: Awaited<ReturnType<typeof reads>>[] = [];
      for (const id of worlds) alone.push(await reads(id));
      // timed as a request is, so each batch waits for the request's quiet point as it does live
      const together = await withQueryTiming(newQueryTiming(), () =>
        withReadMemo(() => readAcross(worlds, String, reads)),
      );
      // each world's feedback names reporters beside the person, agents of other projects among them
      for (const [home, releases, shipped] of alone) {
        const reporters = new Set(home.feedback.map((s) => s.reporter.id));
        expect(reporters.size).toBeGreaterThan(2);
        expect(home.feedback.every((s) => s.reporter.name)).toBe(true);
        expect(releases.releases.length).toBeGreaterThan(0);
        expect(shipped.releases.length).toBeGreaterThan(0);
      }
      expect(together).toEqual(alone);
    } finally {
      vi.useRealTimers();
    }
  });
});
