/**
 * What a served commit carries is asked of the source host once and kept, so a read after a deploy
 * answers it and asks nothing. forge-dev, 2026-10-30: every push to `dev` deploys and a `-dev.N` is
 * only a snapshot, so production served b4499fa11, a commit no release recorded; K157's passes on
 * ISS-780 at runtime e54c95e12e, its ancestor, read `unread` on the criteria read, and requirement
 * coverage could not say the live build held them. The pipeline sweep's pass now reads what each
 * project serves, asks for each pair nothing holds, and keeps the answer (`served_ancestry`); a host
 * that does not answer keeps nothing, and the next pass asks again.
 *
 * And a verdict recorded before an issue's latest reopen is evidence about the build the reopen
 * rejected: requirement coverage read ISS-780's K157 verdicts (09:31) as not judged after REQ-79
 * BC-5's fail reopened it (10:13), while the criteria read and the release hold stood on them.
 *
 * A restart is planted by the host a read resolves being keyed apart from the one the pass asked
 * through: the process's own carriage cache, keyed by repository, holds nothing for it.
 *
 * @direct-test-of packages/core/src/release-batch/served-ancestry.ts
 * @direct-test-of packages/core/src/release-batch/judged-build.ts
 * @direct-test-of packages/core/src/issues/criteria-verdicts.ts
 */

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { standingCriteriaOf } from '../../src/issues/index.js';
import { liveBuildHolds } from '../../src/release-batch/judged-build.js';
import { READ_PATH_HELD_ONLY } from '../../src/release-batch/runtime-weighing.js';
import {
  ANCESTRY_ASKS_PER_PASS,
  persistedCarriage,
  readServedAncestry,
} from '../../src/release-batch/served-ancestry.js';
import { shippedReleaseRuns } from '../../src/release-batch/shipped-releases.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const H = vi.hoisted(() => {
  const ancestor = 'e54c95e12e4b1346d9855caa29ba89ba6ba40c43';
  const state = {
    calls: 0,
    /** The repository the next resolved host names: a new name is a new process's empty cache. */
    process: 1,
    /** Judged commits the host refuses to compare, as a 429 would. */
    refusing: new Set<string>(),
  };
  const host = () => ({
    fullName: `SidCorp-co/forge#process-${state.process}`,
    compare: async (base: string) => {
      state.calls += 1;
      if (state.refusing.has(base)) throw new Error('429 Too Many Requests');
      return base === ancestor ? 'ahead' : 'diverged';
    },
    compareFiles: async () => {
      state.calls += 1;
      return { status: 'diverged', files: ['packages/core/src/index.ts'], changes: [] };
    },
    commitFiles: async () => {
      state.calls += 1;
      return { files: [], changes: [] };
    },
  });
  return { ancestor, state, host };
});

vi.mock('../../src/integrations/source-host/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/index.js')>()),
  resolveSourceHost: async () => H.host(),
}));

const PROBE = 'https://forge-dev-api.example.test/api/version';
/** What production serves: a push to `dev` no release recorded, as b4499fa11 was. */
const HAND = 'b4499fa11da526c29ab0251ed9c3354a88d76cfd';
const DEV_378 = 'bb7a06b6eba60adee2bb092315c52784101be3f4';
const K157 = H.ancestor;
/** A commit that is not an ancestor of what is served. */
const ASIDE = '9a258402c0ffee00c0ffee00c0ffee00c0ffee00';

let projectId: string;
let ownerId: string;
let token: string;
let seq = 0;

async function forgeDevProject(production = true): Promise<void> {
  await seedProjectDocument(projectId, ownerId, {
    environments: (production
      ? {
          production: {
            tier: 'production',
            deploysFrom: 'dev',
            deployment: { mode: 'external' },
            url: 'https://forge-dev-api.example.test',
            verification: {
              runtime: [{ type: 'http', url: PROBE, path: 'sourceCommit', identifies: 'source' }],
            },
          },
        }
      : {}) as never,
    defaultBranch: 'dev',
    extra: { delivery: { verdictsRequired: true } } as never,
  });
}

/** A closed issue, one criterion each passed at `[kind, ref]`, recorded `at`. */
async function judgedIssue(
  verdicts: ReadonlyArray<readonly ['runtime' | 'commit', string]>,
  at = new Date(),
): Promise<string> {
  seq += 1;
  const [row] = (await db.execute(sql`
    INSERT INTO issues (project_id, iss_seq, title, status, created_by_id, merged_at,
                        merged_commit_sha, merged_target)
    VALUES (${projectId}, ${seq}, ${`ISS-${seq}`}, 'in_progress', ${ownerId}, now(), ${K157}, 'dev')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const id = (row as { id: string }).id;
  await replaceCriteria(
    id,
    verdicts.map((_, i) => ({ n: i + 1, statement: `Criterion ${i + 1} holds on dev.` })),
  );
  for (const [i, [kind, ref]] of verdicts.entries()) {
    await db.execute(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind,
                                      commit_sha, runtime_ref, author_user_id, author_agency, judge,
                                      created_at)
      SELECT id, ${id}, 'pass', 'Called the route on dev.', ${kind},
             ${kind === 'commit' ? ref : null}, ${kind === 'runtime' ? ref : null},
             ${ownerId}, 'agent', 'qa', ${at.toISOString()}
        FROM issue_criteria WHERE issue_id = ${id} AND n = ${i + 1} AND retired_at IS NULL
    `);
  }
  await seedIssueStatus(id, 'closed');
  return id;
}

async function reopenAt(issueId: string, at: Date): Promise<void> {
  await db.execute(sql`
    INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type,
                                    actor_agency, actor_id, source, created_at)
    VALUES ('issue', ${issueId}, 'closed', 'reopen', 'user', 'human', ${ownerId}, 'issues',
            ${at.toISOString()})
  `);
}

interface Weighing {
  earned: boolean | null;
  standing: string | null;
  reason: string;
}

async function criteriaRead(issueId: string): Promise<Map<number, Weighing>> {
  const res = await api(token, 'GET', `/api/issues/${issueId}/criteria`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const criteria = res.body.criteria as Array<{ n: number; weighing: Weighing }>;
  return new Map(criteria.map((c) => [c.n, c.weighing]));
}

/** A deploy: the next host resolved is a new process's, holding no carriage of the last. */
const restart = () => {
  H.state.process += 1;
};

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  await addProjectMember(projectId, ownerId, 'admin');
  token = await userToken(ownerId);
  H.state.refusing.clear();
  restart();
  const real = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(PROBE)) return Response.json({ sourceCommit: HAND });
    return real(input, init);
  });
});

afterEach(() => vi.restoreAllMocks());

describe('what a hand-deployed served commit carries is kept (forge-dev ISS-780, K157)', () => {
  it('reads K157 unread until the pass asks, then carried after a restart, asking nothing', async () => {
    await forgeDevProject();
    const id = await judgedIssue([['runtime', K157]]);

    expect((await criteriaRead(id)).get(1)).toMatchObject({ earned: null, standing: 'unread' });

    const pass = await readServedAncestry();
    expect(pass).toMatchObject({ written: 1, unread: 0 });

    restart();
    const asked = H.state.calls;
    const read = await criteriaRead(id);

    expect(H.state.calls).toBe(asked);
    expect(read.get(1)).toMatchObject({ earned: true, standing: 'carried' });
    expect(read.get(1)?.reason).toContain(
      `and what it serves carries it: \`${HAND}\` descends from it: the source host answered so at`,
    );
  });

  it('lets coverage say the live build holds it, from the kept answer', async () => {
    await forgeDevProject();
    await judgedIssue([['commit', K157]]);
    await readServedAncestry();
    restart();
    const asked = H.state.calls;

    const holds = await liveBuildHolds(
      projectId,
      { commits: [K157] },
      {
        served: async () => ({ ok: true, value: HAND }),
        releases: shippedReleaseRuns,
        ancestry: async () => {
          throw new Error('a read asks no ancestry source');
        },
        withdrawn: async () => false,
        heldAncestry: persistedCarriage,
      },
    );

    expect(H.state.calls).toBe(asked);
    expect(holds?.holds.get(K157)).toBe(true);
    expect(holds?.unanswered.size).toBe(0);
  });

  it('keeps nothing where the host refuses, reads unread, and asks again next pass', async () => {
    await forgeDevProject();
    const id = await judgedIssue([['runtime', K157]]);
    H.state.refusing.add(K157);

    expect(await readServedAncestry()).toMatchObject({ written: 0, unread: 1 });
    const read = await criteriaRead(id);
    expect(read.get(1)).toMatchObject({ earned: null, standing: 'unread' });
    expect(read.get(1)?.reason).toContain(READ_PATH_HELD_ONLY);

    H.state.refusing.clear();
    expect(await readServedAncestry()).toMatchObject({ written: 1 });
    expect((await criteriaRead(id)).get(1)).toMatchObject({ earned: true, standing: 'carried' });
  });

  it('reads a commit what is served does not descend from as superseded, naming the files', async () => {
    await forgeDevProject();
    const id = await judgedIssue([['runtime', ASIDE]]);

    expect(await readServedAncestry()).toMatchObject({ written: 1 });
    restart();
    const read = await criteriaRead(id);

    expect(read.get(1)).toMatchObject({ earned: false, standing: 'superseded' });
    expect(read.get(1)?.reason).toContain(
      'what it serves does not descend from it and differs from it in 1 file it runs: `packages/core/src/index.ts`',
    );
  });

  it('bounds what one pass asks, and asks the rest in the next', async () => {
    await forgeDevProject();
    const judged = Array.from(
      { length: ANCESTRY_ASKS_PER_PASS + 5 },
      (_, i) => `${i.toString(16).padStart(8, '0')}${'0'.repeat(32)}`,
    );
    await judgedIssue(judged.map((j) => ['runtime', j] as const));
    await db.execute(sql`
      INSERT INTO pipeline_runs (project_id, kind, status, created_at, started_at, release_version,
                                 release_released_at, metadata)
      VALUES (${projectId}, 'system', 'completed', now(), now(), '0.4.0-dev.378', now(),
              ${JSON.stringify({ source: 'release-batch', issueIds: [], finish: { state: 'finished', commit: DEV_378 } })}::jsonb)
    `);

    const pass = await readServedAncestry();

    expect(pass.asked).toBe(ANCESTRY_ASKS_PER_PASS);
    expect(pass.written).toBe(ANCESTRY_ASKS_PER_PASS);
    expect((await readServedAncestry()).written).toBe(5);
  });
});

describe('a reopen voids the verdicts recorded before it, as coverage reads them (ISS-780)', () => {
  it('shows K157 unproven on a production project once a reopen rejected its build', async () => {
    await forgeDevProject();
    const judgedAt = new Date(Date.now() - 60 * 60_000);
    const id = await judgedIssue([['runtime', HAND]], judgedAt);
    expect((await criteriaRead(id)).get(1)).toMatchObject({ earned: true, standing: 'stands' });

    await reopenAt(id, new Date(Date.now() - 30 * 60_000));
    const read = await criteriaRead(id);

    expect(read.get(1)).toMatchObject({ earned: false });
    expect(read.get(1)?.reason).toContain(
      `it was recorded at ${judgedAt.toISOString()}, before this issue's latest reopen`,
    );
  });

  it('keeps a commit verdict before the reopen where the project declares no production', async () => {
    await forgeDevProject(false);
    const id = await judgedIssue([['commit', K157]], new Date(Date.now() - 60 * 60_000));
    await reopenAt(id, new Date(Date.now() - 30 * 60_000));

    const standing = (await standingCriteriaOf([id])).get(id);

    expect(standing?.criteria[0]?.verdict).toMatchObject({ verdict: 'pass', unverified: null });
  });
});
