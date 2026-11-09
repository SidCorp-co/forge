/**
 * A deploy does not drop what the build served before held to not judged (ISS-1182, FB-592). On
 * forge-dev every push deploys, and no pair the served-ancestry pass asked names the new live commit:
 * right after dev.619 deployed 4782a3c819ee, REQ-12 read 8/23, then 13/23 and 16/23, and was back at
 * 21/23 four minutes later, the pass asking one pair a commit at most thirty a pass. The pass keeps
 * what production was read serving, and after a deploy asks first whether the new build descends from
 * the one served before: a verdict that build held reads held, marked as re-checked, until then, and
 * held after, with no pair a commit asked.
 *
 * @direct-test-of packages/core/src/release-batch/served-builds.ts
 * @direct-test-of packages/core/src/release-batch/served-ancestry.ts
 * @direct-test-of packages/core/src/release-batch/judged-build.ts
 * @direct-test-of packages/core/src/db/schema-served-ancestry.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { backgroundSettled } from '../../src/lib/background.js';
import { type JudgedBuildDeps, liveBuildHolds } from '../../src/release-batch/judged-build.js';
import {
  keepHolding,
  persistedCarriage,
  readServedAncestry,
} from '../../src/release-batch/served-ancestry.js';
import { keepLiveBuild, servedBefore } from '../../src/release-batch/served-builds.js';
import { shippedReleaseRuns } from '../../src/release-batch/shipped-releases.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const H = vi.hoisted(() => {
  const state = {
    calls: [] as string[],
    /** The repository the host names, new per test: the process's carriage cache is keyed by it. */
    process: 0,
    /** `judged>served` pairs the host answers the served commit descends from. */
    descends: new Set<string>(),
  };
  const host = () => ({
    fullName: `SidCorp-co/forge#process-${state.process}`,
    compare: async (base: string, head: string) => {
      state.calls.push(`${base}>${head}`);
      return state.descends.has(`${base}>${head}`) ? 'ahead' : 'diverged';
    },
    compareFiles: async () => ({ status: 'diverged', files: ['src/a.ts'], changes: [] }),
    commitFiles: async () => ({ files: [], changes: [] }),
  });
  return { state, host };
});

vi.mock('../../src/integrations/source-host/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/index.js')>()),
  resolveSourceHost: async () => H.host(),
}));

const PROBE = 'https://forge-dev-api.example.test/api/version';
/** dev.618's build, served before the deploy, and judged at. */
const BEFORE = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';
/** dev.619's build, 4782a3c819ee, deployed after it. */
const AFTER = '4782a3c819ee0011223344556677889900aabbcc';
/** An earlier build the one before held, judged at too. */
const EARLIER = '1111aaaa2222bbbb3333cccc4444dddd5555eeee';
/** 826231cc63's place: served between two deploys a few minutes apart, never read by a pass. */
const MIDDLE = '826231cc633b3fe3cd8b9d562fe9a53c0dcbdc9e';
/** A commit judged off the line: the build before did not hold it. */
const ASIDE = '9a258402c0ffee00c0ffee00c0ffee00c0ffee00';

let projectId: string;
let ownerId: string;
let serving = BEFORE;
let seq = 0;

async function judgedIssue(runtimes: readonly string[], landing = EARLIER): Promise<void> {
  seq += 1;
  const [row] = (await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, created_by_id, merged_at,
                        merged_commit_sha, merged_target)
    VALUES (${projectId}, ${seq}, ${`ISS-${seq}`}, 'in_progress', ${ownerId}, now(), ${landing}, 'dev')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const id = (row as { id: string }).id;
  await replaceCriteria(
    id,
    runtimes.map((_, i) => ({ n: i + 1, statement: `Criterion ${i + 1} holds on dev.` })),
  );
  for (const [i, ref] of runtimes.entries()) {
    await db.execute(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind,
                                      runtime_ref, author_user_id, author_agency, judge)
      SELECT id, ${id}, 'pass', 'Called the route on dev.', 'runtime', ${ref},
             ${ownerId}, 'agent', 'qa'
        FROM issue_criteria WHERE issue_id = ${id} AND n = ${i + 1} AND retired_at IS NULL
    `);
  }
  await seedIssueStatus(id, 'closed');
}

/** The read coverage makes of the live build, with what the pass kept and nothing asked. */
const read = (commits: readonly string[]) => {
  const deps: JudgedBuildDeps = {
    served: async () => ({ ok: true, value: serving }),
    releases: shippedReleaseRuns,
    ancestry: async () => {
      throw new Error('a read asks no ancestry source');
    },
    withdrawn: async () => false,
    heldAncestry: persistedCarriage,
    servedBefore,
    keepServed: keepLiveBuild,
  };
  return liveBuildHolds(projectId, { commits }, deps);
};

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  await seedProjectDocument(projectId, ownerId, {
    environments: {
      production: {
        tier: 'production',
        deploysFrom: 'dev',
        deployment: { mode: 'external' },
        url: 'https://forge-dev-api.example.test',
        verification: {
          runtime: [{ type: 'http', url: PROBE, path: 'sourceCommit', identifies: 'source' }],
        },
      },
    } as never,
    defaultBranch: 'dev',
    extra: { delivery: { verdictsRequired: true } } as never,
  });
  serving = BEFORE;
  H.state.calls = [];
  H.state.process += 1;
  H.state.descends = new Set([`${EARLIER}>${BEFORE}`, `${EARLIER}>${AFTER}`]);
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(PROBE)) return Response.json({ sourceCommit: serving });
    return real(input, init);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('a deploy keeps what the build served before held (ISS-1182, FB-592)', () => {
  it('reads it held and re-checked right after the deploy, then held from one pair asked', async () => {
    await judgedIssue([BEFORE, EARLIER, ASIDE]);
    await readServedAncestry();
    const before = await read([BEFORE, EARLIER, ASIDE]);
    expect(before?.holds.get(BEFORE)).toBe(true);
    expect(before?.holds.get(EARLIER)).toBe(true);
    expect(before?.holds.get(ASIDE)).toBe(false);

    // the deploy: production serves AFTER, which no pair the pass asked names
    serving = AFTER;
    H.state.descends.add(`${BEFORE}>${AFTER}`);
    const right = await read([BEFORE, EARLIER, ASIDE]);
    expect(right?.sha).toBe(AFTER);
    expect(right?.holds.get(BEFORE)).toBe(true);
    expect(right?.holds.get(EARLIER)).toBe(true);
    expect(right?.rechecking?.get(EARLIER)).toContain('is being re-checked');
    // what the build before did not hold keeps no answer
    expect(right?.unanswered.has(ASIDE)).toBe(true);

    H.state.calls = [];
    await readServedAncestry();
    // the bridge first, then only what the build before did not hold, never one pair a held commit
    expect(H.state.calls[0]).toBe(`${BEFORE}>${AFTER}`);
    expect(H.state.calls).not.toContain(`${EARLIER}>${AFTER}`);
    expect(H.state.calls).toContain(`${ASIDE}>${AFTER}`);

    const after = await read([BEFORE, EARLIER, ASIDE]);
    expect(after?.holds.get(BEFORE)).toBe(true);
    expect(after?.holds.get(EARLIER)).toBe(true);
    expect(after?.holds.get(ASIDE)).toBe(false);
    expect(after?.rechecking).toBeUndefined();
    expect(after?.unanswered.size).toBe(0);
  });

  it('keeps no answer where the new build does not descend from the one before, and asks each pair', async () => {
    await judgedIssue([BEFORE, EARLIER]);
    await readServedAncestry();
    serving = AFTER;
    H.state.calls = [];
    await readServedAncestry();
    expect(H.state.calls[0]).toBe(`${BEFORE}>${AFTER}`);
    expect(H.state.calls).toContain(`${EARLIER}>${AFTER}`);

    const after = await read([BEFORE, EARLIER]);
    // the host says AFTER does not hold BEFORE: it reads not held, not re-checked
    expect(after?.holds.get(BEFORE)).toBe(false);
    expect(after?.holds.get(EARLIER)).toBe(true);
    expect(after?.rechecking).toBeUndefined();
  });
});

// ISS-1182 round 2, live on forge-dev 2026-11-09: a71284f314 (dev.626) served, then 826231cc63 for
// about 3.5 minutes, then b2cdb0d53c (dev.627). The pass never read 826231cc63, and REQ-12 read 9/23
// with nothing re-checked; at 9e7f8c7750 (dev.628), after 3cd21bcdc7 had been bridged from the
// build before it, 14/23 with nothing re-checked.
describe('two deploys a few minutes apart keep what the builds before held (ISS-1182 r2)', () => {
  it('reads what A and B held, B never read by a pass, as held or re-checked on C', async () => {
    H.state.descends = new Set([
      `${EARLIER}>${BEFORE}`,
      `${EARLIER}>${MIDDLE}`,
      `${EARLIER}>${AFTER}`,
      `${BEFORE}>${MIDDLE}`,
      `${BEFORE}>${AFTER}`,
      `${MIDDLE}>${AFTER}`,
    ]);
    await judgedIssue([BEFORE, EARLIER, ASIDE]);
    await readServedAncestry();

    // B serves, and a pass is judged on it, while no served-ancestry pass runs
    serving = MIDDLE;
    await judgedIssue([MIDDLE], MIDDLE);
    const onB = await read([BEFORE, EARLIER, MIDDLE]);
    expect(onB?.holds.get(MIDDLE)).toBe(true);
    expect(onB?.holds.get(EARLIER)).toBe(true);
    await backgroundSettled();

    // C serves: no pair the pass asked names it
    serving = AFTER;
    const onC = await read([BEFORE, EARLIER, MIDDLE, ASIDE]);
    expect(onC?.sha).toBe(AFTER);
    for (const commit of [BEFORE, EARLIER, MIDDLE]) {
      expect(onC?.unanswered.get(commit), commit).toBeUndefined();
      expect(onC?.holds.get(commit)).toBe(true);
      expect(onC?.rechecking?.get(commit)).toContain('is being re-checked');
    }
    expect(onC?.unanswered.has(ASIDE)).toBe(true);

    // one pass: whether C descends from each build kept before it, never one pair a held commit
    H.state.calls = [];
    await readServedAncestry();
    expect(H.state.calls).toContain(`${MIDDLE}>${AFTER}`);
    expect(H.state.calls).not.toContain(`${EARLIER}>${AFTER}`);
    const settled = await read([BEFORE, EARLIER, MIDDLE, ASIDE]);
    for (const commit of [BEFORE, EARLIER, MIDDLE]) expect(settled?.holds.get(commit)).toBe(true);
    expect(settled?.holds.get(ASIDE)).toBe(false);
    expect(settled?.rechecking).toBeUndefined();
  });

  it('keeps what B held only by deriving it from A once C serves', async () => {
    H.state.descends.add(`${BEFORE}>${MIDDLE}`);
    await judgedIssue([BEFORE, EARLIER]);
    await readServedAncestry();
    serving = MIDDLE;
    H.state.calls = [];
    await readServedAncestry();
    // B's holdings are derived from A's through the one bridge, no pair a commit asked
    expect(H.state.calls).toEqual([`${BEFORE}>${MIDDLE}`]);
    expect((await read([BEFORE, EARLIER]))?.holds.get(EARLIER)).toBe(true);

    serving = AFTER;
    const onC = await read([BEFORE, EARLIER]);
    expect(onC?.unanswered.get(EARLIER)).toBeUndefined();
    expect(onC?.holds.get(EARLIER)).toBe(true);
    expect(onC?.rechecking?.get(EARLIER)).toContain('is being re-checked');
  });

  it('holds what A and B held on C, one commit on top of B, with a pass stepped between each read', async () => {
    H.state.descends = new Set([
      `${EARLIER}>${BEFORE}`,
      `${EARLIER}>${MIDDLE}`,
      `${EARLIER}>${AFTER}`,
      `${BEFORE}>${MIDDLE}`,
      `${BEFORE}>${AFTER}`,
      `${MIDDLE}>${AFTER}`,
    ]);
    await judgedIssue([BEFORE, EARLIER, ASIDE]);
    await readServedAncestry();
    // B serves about five minutes: read, judged on, and read by a pass
    serving = MIDDLE;
    // an issue that landed as B, judged there
    await judgedIssue([MIDDLE], MIDDLE);
    await read([BEFORE, EARLIER, MIDDLE]);
    await backgroundSettled();
    await readServedAncestry();
    const onB = await read([BEFORE, EARLIER, MIDDLE, ASIDE]);
    for (const commit of [BEFORE, EARLIER, MIDDLE])
      expect(onB?.holds.get(commit), commit).toBe(true);

    // C, B's release commit, serves: read before any pass names it, then after one
    serving = AFTER;
    const first = await read([BEFORE, EARLIER, MIDDLE, ASIDE]);
    for (const commit of [BEFORE, EARLIER, MIDDLE]) {
      expect(first?.unanswered.get(commit), commit).toBeUndefined();
      expect(first?.rechecking?.get(commit), commit).toContain('is being re-checked');
    }
    await backgroundSettled();
    // the bridge answered before anything else (the operator's watch: re-checked cleared in 20-60 s
    // while passing stayed low): each re-checked hold turns to held, never to not judged
    await keepHolding(projectId, MIDDLE, AFTER);
    const bridged = await read([BEFORE, EARLIER, MIDDLE, ASIDE]);
    for (const commit of [BEFORE, EARLIER, MIDDLE]) {
      expect(bridged?.unanswered.get(commit), commit).toBeUndefined();
      expect(bridged?.holds.get(commit), commit).toBe(true);
      expect(bridged?.rechecking?.has(commit) ?? false, commit).toBe(false);
    }
    await readServedAncestry();
    const settled = await read([BEFORE, EARLIER, MIDDLE, ASIDE]);
    for (const commit of [BEFORE, EARLIER, MIDDLE]) {
      expect(settled?.unanswered.get(commit), commit).toBeUndefined();
      expect(settled?.holds.get(commit), commit).toBe(true);
    }
    expect(settled?.holds.get(ASIDE)).toBe(false);
    expect(settled?.rechecking).toBeUndefined();
  });
});
