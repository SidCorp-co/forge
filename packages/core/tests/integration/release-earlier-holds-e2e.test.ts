/**
 * ISS-1079 round 3 (sidcorp-mail, 2026-11-07): round 2's door attached 62a4ac7 to release 0.16.0 and
 * REQ-6 still read 1 of 5. ISS-7 landed at 3908750d and was shipped by the earlier release 0.9.0; its
 * five passes sit at 62a4ac7, the commit 0.16.0 shipped, and 0.16.0 carried ISS-11 only. Coverage
 * joined a verdict's commit only to the release holding the issue (`shipped-holding.ts`), so a pass
 * at a later release's commit counted for nothing, though that commit holds ISS-7's landing.
 *
 * A pass at a shipped release's commit now counts where Forge's recorded ancestry says that commit
 * holds the issue's landing, or the commit of the release that holds the issue: the landing marks
 * (`recorded-holding.ts`) and the kept host answers (`served_ancestry`). An unrecorded pair reads
 * unread with its reason and asks no host on the read; the pipeline sweep's served-ancestry pass asks
 * the host once and keeps the answer, and the attach door keeps what it learns. Never inferred from
 * version order: a hotfix cut from an older tag does not hold a landing made after it.
 *
 * And the completed run's read (forge-core-61, run 8250311b): `GET …/release-batches/:runId` on a
 * shipped run answered `issues: []` and `gateStatus: 'awaiting_release'`, reading the live gate. It
 * now names the issues the run shipped and its finished state, from the run's own record.
 *
 * @direct-test-of packages/core/src/release-batch/shipped-holding.ts
 * @direct-test-of packages/core/src/release-batch/landed-build-holds.ts
 * @direct-test-of packages/core/src/release-batch/served-ancestry.ts
 * @direct-test-of packages/core/src/release-batch/verdict-commit-placement.ts
 * @direct-test-of packages/core/src/release-batch/shipped-commit.ts
 * @direct-test-of packages/core/src/release-batch/queries.ts
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { readServedAncestry } from '../../src/release-batch/served-ancestry.js';
import { api } from '../helpers/api.js';
import { seedIssueStatus } from '../helpers/factories.js';
import { agreedRequirement, bcOf, traced } from '../helpers/landed-requirement.js';
import { landedIssue, world } from '../helpers/landed-world.js';
import { LANDING, SHIPPED } from '../helpers/shipped-commit-host.js';
import {
  attach,
  coverageOf,
  passedAt,
  type Source,
  shippedRun,
  useShippedCommitWorld,
} from '../helpers/shipped-commit-world.js';

const H = vi.hoisted(() => {
  /** ISS-7's landing (MR !71), which 0.9.0 shipped and 62a4ac7 holds. */
  const earlier = '3908750d4c1b2a39485766f8091a2b3c4d5e6f70';
  const shipped = '62a4ac7cb007502d7285874fe8e6e13337b74f94';
  const landing = '7b42608aa1d4e5f60718293a4b5c6d7e8f90a1b0';
  const state = { calls: 0, process: 0 };
  const host = () => ({
    provider: 'gitlab',
    fullName: `sidcorp/mail#${state.process}`,
    compare: async (base: string, head: string) => {
      state.calls += 1;
      return [earlier, landing].includes(base.toLowerCase()) && head.toLowerCase() === shipped
        ? 'ahead'
        : 'diverged';
    },
    compareFiles: async () => {
      state.calls += 1;
      return { status: 'diverged', files: ['admin-ui/src/inbox.ts'], changes: [] };
    },
    commitFiles: async () => {
      state.calls += 1;
      return { files: [], changes: [] };
    },
    readChangeRequestChecks: async () => [],
  });
  return { earlier, state, host };
});

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => H.host(),
}));

useShippedCommitWorld();

beforeEach(() => {
  H.state.calls = 0;
  // a new repository name is a new process: nothing the host answered before is cached
  H.state.process += 1;
});

/** ISS-7's landing, as 0.9.0 shipped it. */
const EARLIER = H.earlier;
/** A hotfix cut from a tag older than ISS-7's landing, which holds none of it. */
const HOTFIX = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
/** The merge commit 0.9.0 shipped where it is not ISS-7's landing itself. */
const RELEASE_MERGE = 'a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9';
const ATTACHED: Source = { from: 'attached', said: 'attached by owner' };

/** A closed issue landed at `landing`, its criterion 1 traced to `bc` of `req`. */
async function landedOn(req: string, seq: number, landing: string, bc: string): Promise<string> {
  const issue = await landedIssue(seq, landing, [`The webmail holds ${bc}`]);
  await traced(req, issue, seq, { 1: bc });
  return issue;
}

/**
 * sidcorp-mail as it stood: ISS-7 shipped by 0.9.0 at `earlierAt`, ISS-11 by 0.16.0 at `laterAt`,
 * both judged at `laterAt`. BC-1 is ISS-7's, BC-2 ISS-11's.
 */
async function twoReleases(laterAt: string, earlierAt = EARLIER) {
  const req = await agreedRequirement(['The inbox lists mail', 'The webmail serves the release']);
  const x = await landedOn(req, 7, EARLIER, 'BC-1');
  await shippedRun(x, {}, { version: '0.9.0', commit: earlierAt, source: ATTACHED });
  await seedIssueStatus(x, 'closed');
  const y = await landedOn(req, 11, LANDING, 'BC-2');
  await shippedRun(y, {}, { version: '0.16.0', commit: laterAt, source: ATTACHED });
  await seedIssueStatus(y, 'closed');
  await passedAt(x, laterAt);
  await passedAt(y, laterAt);
  return { req, x, y };
}

async function keptRows() {
  return [
    ...(await db.execute<{ served: string; judged: string; carried: boolean }>(sql`
      SELECT served_commit AS served, judged_commit AS judged, carried FROM served_ancestry
       WHERE project_id = ${world.projectId} ORDER BY judged_commit`)),
  ];
}

describe('a pass at a later release commit counts for an issue an earlier release holds (ISS-1079 r3)', () => {
  it('reads unread with its reason and asks no host, then counts once the sweep keeps the pair', async () => {
    const { req } = await twoReleases(SHIPPED);

    expect(await coverageOf(req)).toEqual({ criteria: 2, passing: 1, judged: 1 });
    const why = (await bcOf(req, 'BC-1')).issues[0]?.notCounted ?? '';
    expect(why).toContain(SHIPPED.slice(0, 12));
    expect(why).toContain('release 0.16.0');
    expect(why).toContain(EARLIER.slice(0, 12));
    expect(why).toContain('pipeline sweep');
    expect(H.state.calls).toBe(0);

    const pass = await readServedAncestry();
    expect(pass.written).toBeGreaterThanOrEqual(1);
    expect(await keptRows()).toContainEqual({ served: SHIPPED, judged: EARLIER, carried: true });

    const asked = H.state.calls;
    expect(await coverageOf(req)).toEqual({ criteria: 2, passing: 2, judged: 2 });
    expect((await bcOf(req, 'BC-1')).issues[0]?.notCounted ?? null).toBeNull();
    expect(H.state.calls).toBe(asked);
  });

  it('counts nothing at a hotfix commit that does not hold the landing, and says why', async () => {
    const { req } = await twoReleases(HOTFIX);

    await readServedAncestry();
    // neither way: the hotfix does not hold the landing, nor does the landing descend from it
    expect(await keptRows()).toContainEqual({ served: HOTFIX, judged: EARLIER, carried: false });
    expect(await keptRows()).toContainEqual({ served: EARLIER, judged: HOTFIX, carried: false });

    const coverage = await coverageOf(req);
    expect(coverage.passing).toBe(1);
    const why = (await bcOf(req, 'BC-1')).issues[0]?.notCounted ?? '';
    expect(why).toContain(HOTFIX.slice(0, 12));
    expect(why).toContain(EARLIER.slice(0, 12));
    expect(why).toContain('does not descend from');
    expect(why).toContain('judged another build');
  });

  it('counts where the kept ancestry says the later commit holds the commit the earlier release shipped', async () => {
    const { req } = await twoReleases(SHIPPED, RELEASE_MERGE);
    await db.execute(sql`
      INSERT INTO served_ancestry (project_id, served_commit, judged_commit, carried)
      VALUES (${world.projectId}, ${SHIPPED}, ${RELEASE_MERGE}, true)`);

    expect(await coverageOf(req)).toEqual({ criteria: 2, passing: 2, judged: 2 });
    expect(H.state.calls).toBe(0);
  });

  it('keeps what the attach door learned from the host about each landing it carried', async () => {
    const req = await agreedRequirement(['The webmail serves the release']);
    const y = await landedOn(req, 11, LANDING, 'BC-1');
    await seedIssueStatus(y, 'closed');
    const runId = await shippedRun(y);

    const res = await attach(runId, SHIPPED);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await keptRows()).toContainEqual({ served: SHIPPED, judged: LANDING, carried: true });
    expect(String((res.body as { said?: string }).said)).toMatch(/^attached by [0-9a-f-]{36}/);
  });
});

describe('the read of a completed release run names what it shipped (ISS-1079 r3)', () => {
  it('names the issues the run shipped and its finished state, from its own record', async () => {
    const req = await agreedRequirement(['The webmail serves the release']);
    const y = await landedOn(req, 11, LANDING, 'BC-1');
    await seedIssueStatus(y, 'closed');
    const runId = await shippedRun(y, {}, { commit: SHIPPED, source: ATTACHED });

    const res = await api(
      world.token,
      'GET',
      `/api/projects/${world.projectId}/release-batches/${runId}`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      gateStatus: null,
      ended: { state: 'shipped', commit: SHIPPED, finish: 'finished' },
      issues: [{ id: y, displayId: 'ISS-11', status: 'closed' }],
    });
  });
});
