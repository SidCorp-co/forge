// ISS-1070 r22: a contracts read names its own project and interface with the projects its edges
// reach, a run's terminal move and its session's are one read, and which open change requests deliver
// an issue, and its merge, are read once a request. Each project's reads answer there what they
// answer alone, with an ecosystem project outside the person's set consuming and providing contracts,
// ended run sessions, and open change requests delivering issues. Its own suite, so the reads-alike
// suites coordinate no more modules than archmap allows (no-coordinator-blob).
// @direct-test-of packages/core/src/ecosystem/standing/read.ts
// @direct-test-of packages/core/src/runs/facts-read.ts
// @direct-test-of packages/core/src/release-batch/change-request-roster.ts
// @direct-test-of packages/core/src/release-batch/change-request-build.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { newQueryTiming, withQueryTiming } from '../../src/db/query-timing.js';
import { readAcross, withReadMemo } from '../../src/db/read-memo.js';
import { readContractStanding } from '../../src/ecosystem/standing/read.js';
import { changeRequestBuildsOf } from '../../src/release-batch/change-request-build.js';
import { openChangeRequestsOf } from '../../src/release-batch/change-request-roster.js';
import { listRunStanding } from '../../src/runs/read.js';
import { closeWorld, testEnv } from '../helpers/ecosystem-world.js';
import { createTestUser, seedOrg } from '../helpers/factories.js';
import { consumedFromOutside } from '../helpers/live-mix-people.js';
import { sessionsEnded } from '../helpers/live-mix-waits.js';
import { seedEcosystem } from '../helpers/live-wiring.js';
import { type Scale, seedAtScale } from '../helpers/scale-world.js';

const SMALL: Scale = {
  requirements: 3,
  criteriaPerRequirement: 2,
  issues: 30,
  criteriaPerIssue: 2,
  verdictsPerCriterion: 2,
  releases: 6,
  feedback: 6,
  activityPerIssue: 1,
  open: 10,
  live: true,
  states: true,
};

let personId: string;
let worlds: string[];

/** Two open change requests on `projectId`, each delivering two of its open issues, one shared. */
async function openRequests(projectId: string): Promise<void> {
  const connectionId = randomUUID();
  const bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connectionId}, 'user', ${personId}, 'github', true)`);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${bindingId}, ${connectionId}, ${projectId}, 'github', 'source', true,
            ${JSON.stringify({ repository: `acme/${projectId.slice(0, 8)}` })}::jsonb)`);
  for (const n of [1, 2]) {
    await db.execute(sql`
      WITH pr AS (
        INSERT INTO repo_pull_requests (project_id, binding_id, number, repo_full_name, title, state,
                                        head_ref, head_sha, base_ref, base_sha)
        VALUES (${projectId}, ${bindingId}, ${n}, 'acme/x', ${`Request ${n}`}, 'open',
                ${`feat/r${n}`}, ${`${n}`.repeat(40)}, 'dev', ${'f'.repeat(40)})
        RETURNING id
      )
      INSERT INTO repo_pull_request_issues (pull_request_id, issue_id, linked_by, position)
      SELECT pr.id, i.id, 'title', i.iss_seq
        FROM pr, issues i
       WHERE i.project_id = ${projectId} AND i.status NOT IN ('closed', 'dropped')
         AND i.iss_seq IN (SELECT iss_seq FROM issues WHERE project_id = ${projectId}
                             AND status NOT IN ('closed', 'dropped') ORDER BY iss_seq LIMIT 3 OFFSET ${n - 1})`);
  }
}

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  personId = (await createTestUser({ verified: true })).id;
  const orgId = await seedOrg(personId);
  const ecosystemId = await seedEcosystem(personId, orgId);
  worlds = [];
  for (let n = 0; n < 3; n++) worlds.push(await seedAtScale(personId, SMALL, { orgId }));
  for (const id of worlds) {
    await db.execute(sql`
      INSERT INTO ecosystem_memberships (ecosystem_id, project_id, state, invited_by, decided_by, decided_at)
      VALUES (${ecosystemId}, ${id}, 'active', ${personId}, ${personId}, now())`);
    await consumedFromOutside(id, ecosystemId, true);
    await sessionsEnded(id, personId);
    await openRequests(id);
  }
}, 300_000);

afterAll(closeWorld);

describe("inside one read across a person's projects, contracts, runs and change requests read alike (ISS-1070 r22)", () => {
  it("answers each project's contracts, runs and change-request builds alike", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
    try {
      const now = new Date();
      const reads = async (projectId: string) => {
        const open = (
          (await db.execute(sql`
            SELECT id::text FROM issues WHERE project_id = ${projectId} ORDER BY iss_seq`)) as unknown as Array<{
            id: string;
          }>
        ).map((r) => r.id);
        return Promise.all([
          readContractStanding(projectId, personId, now),
          listRunStanding(projectId, { scope: 'all', limit: 20, offset: 0 }, null),
          openChangeRequestsOf(projectId, open),
          changeRequestBuildsOf(projectId, open).then((m) => [...m]),
        ]);
      };
      const alone: Awaited<ReturnType<typeof reads>>[] = [];
      for (const id of worlds) alone.push(await reads(id));
      // timed as a request is, so each batch waits for the request's quiet point as it does live
      const together = await withQueryTiming(newQueryTiming(), () =>
        withReadMemo(() => readAcross(worlds, String, reads)),
      );
      // each world's contracts reach the project outside the person's set, its runs ended sessions,
      // and two open requests deliver its issues
      for (const [contracts, runs, requests] of alone) {
        expect(contracts.contracts.map((c) => c.direction)).toContain('consumed');
        expect(runs.items.length).toBeGreaterThan(0);
        expect(requests.map((r) => r.number)).toEqual([1, 2]);
      }
      expect(together).toEqual(alone);
    } finally {
      vi.useRealTimers();
    }
  });
});
