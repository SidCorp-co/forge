// ISS-1070 r20: what waits on a person in some of a person's projects is read once for all of them
// at the request's quiet point: a fire's steward report read with the fire, a question's subject,
// the head designs a re-pin reads, and a design change's workflow read with the suggestion. Each
// project's reads answer there what they answer alone. Split from
// `reads-alike-in-one-request-e2e.test.ts`, whose reads already reach as many modules as one test
// coordinates (archmap's no-coordinator-blob).
// @direct-test-of packages/core/src/automation/facts.ts
// @direct-test-of packages/core/src/questions/subject.ts
// @direct-test-of packages/core/src/workflows/head-designs-read.ts
// @direct-test-of packages/core/src/workflows/design-repin-service.ts
// @direct-test-of packages/core/src/suggestions/waiting-read.ts

import { AUTOMATION_FIRES_DEFAULT } from '@forge/contracts/automation-standing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { automationViewerOf, readAutomationStanding } from '../../src/automation/index.js';
import { db } from '../../src/db/client.js';
import { newQueryTiming, withQueryTiming } from '../../src/db/query-timing.js';
import { readAcross, withReadMemo } from '../../src/db/read-memo.js';
import { readOpenPersonQuestions } from '../../src/questions/index.js';
import { waitingSuggestionsFor } from '../../src/suggestions/waiting-read.js';
import { repinGroupsOf } from '../../src/workflows/design-repin-service.js';
import { headDesignsRead } from '../../src/workflows/head-designs-read.js';
import { headDesignsOf } from '../../src/workflows/store.js';
import { closeWorld, testEnv } from '../helpers/ecosystem-world.js';
import { createTestUser, seedOrg } from '../helpers/factories.js';
import {
  askAboutRequirement,
  baseDesigns,
  proposeDesignChanges,
  stewardFired,
} from '../helpers/live-mix-waits.js';
import { type Scale, seedAtScale } from '../helpers/scale-world.js';

// the scale `reads-alike-in-one-request-e2e.test.ts` reads across, whose projects hold these waits
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
  // what waits on a person in some of forge-dev's projects; the third project holds none of it
  for (const id of worlds.slice(0, 2)) {
    await stewardFired(id, personId);
    await askAboutRequirement(id);
    await baseDesigns(id);
    await proposeDesignChanges(id);
  }
}, 180_000);

afterAll(closeWorld);

describe("inside one read across a person's projects, what waits on a person reads alike (ISS-1070 r20)", () => {
  it("answers each project's steward reports, open questions, head designs, re-pins and waiting suggestions alike", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
    try {
      const now = new Date();
      const reads = async (projectId: string) =>
        Promise.all([
          automationViewerOf(projectId, personId).then((v) =>
            v
              ? readAutomationStanding(projectId, v, { firesLimit: AUTOMATION_FIRES_DEFAULT }, now)
              : null,
          ),
          readOpenPersonQuestions(projectId),
          headDesignsRead(projectId),
          repinGroupsOf(projectId),
          waitingSuggestionsFor(projectId, () => true),
        ]);
      const alone: Awaited<ReturnType<typeof reads>>[] = [];
      for (const id of worlds) alone.push(await reads(id));
      // timed as a request is, so each batch waits for the request's quiet point as it does live
      const together = await withQueryTiming(newQueryTiming(), () =>
        withReadMemo(() => readAcross(worlds, String, reads)),
      );
      // the two worlds holding what waits on a person read it, so no read compares two empty answers
      for (const [n, id] of worlds.slice(0, 2).entries()) {
        const [automation, questions, heads, , suggestions] = alone[n] as Awaited<
          ReturnType<typeof reads>
        >;
        expect(automation?.proposals.length).toBeGreaterThan(0);
        expect(questions.map((q) => q.subject?.kind)).toContain('requirement');
        expect(heads.length).toBeGreaterThan(0);
        // the rows a transaction reads, less the project each batched row names
        expect(heads.map(({ projectId: _p, ...d }) => d)).toEqual(await headDesignsOf(db, id));
        expect(suggestions.some((s) => s.target.type === 'workflow')).toBe(true);
      }
      expect(together).toEqual(alone);
    } finally {
      vi.useRealTimers();
    }
  });
});
